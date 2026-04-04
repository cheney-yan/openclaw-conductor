import {
  Events,
  Interaction,
  Message,
  TextChannel,
  ThreadChannel,
  ChannelType,
  DMChannel,
  Collection,
  Snowflake,
} from 'discord.js';
import type { ConductorClient } from '../client';
import { logger } from '../../logger';
import { chat, abortIfRunning, steerIfRunning, isAgentRunning, type ToolEvent, type DiscordContext } from '../../agent/conductor-agent';
import { resolveDmSession, forceNewDmSession, loadContext } from '../../agent/context-store';
import { writeMemoryBlock, appendMemorySummary } from '../../agent/long-term-memory';
import { fetchChannelHistory, fetchThreadHistory, NEW_SESSION_MARKER } from '../../agent/channel-history';

// Track the active "thinking" message per thread so we can mark it cancelled
const activeThinking = new Map<string, Message>();

// Dedup: ignore a message we've already handled (e.g. MessageCreate + MessageUpdate race)
const handledMessageIds = new Set<string>();

async function markCancelled(threadId: string): Promise<void> {
  const old = activeThinking.get(threadId);
  if (old) {
    await old.edit('~~_thinking..._~~ *(interrupted)*').catch(() => {});
    activeThinking.delete(threadId);
  }
}

/** Returns true if the message is a hard-stop signal. */
function isHardStop(text: string): boolean {
  return /^stop$/i.test(text.trim());
}

function toolEmoji(toolName: string, isError: boolean): string {
  if (isError) return '❌';
  if (toolName.startsWith('openclaw_cli')) return '⚙️';
  if (toolName.startsWith('openclaw_read')) return '📖';
  if (toolName.startsWith('openclaw_snapshot')) return '💾';
  if (toolName.startsWith('memory')) return '🧠';
  if (toolName === 'create_channel' || toolName === 'rename_channel') return '📁';
  if (toolName === 'archive_channel') return '🗄️';
  if (toolName === 'list_channels' || toolName === 'fetch_channel_messages') return '🔍';
  return '🔧';
}

async function runChat(
  guild: Parameters<typeof chat>[0],
  text: string,
  threadId: string,
  replyChannel: { send: (s: string) => Promise<Message> },
  originalMsg: Message,
  discordCtx?: DiscordContext,
  contextOverride?: string,
): Promise<void> {
  // ── If agent is already running: steer or hard-stop ──────────────────────
  if (isAgentRunning(threadId)) {
    if (isHardStop(text)) {
      abortIfRunning(threadId);
      await markCancelled(threadId);
      await originalMsg.react('🛑');
    } else {
      steerIfRunning(threadId, text);
      await originalMsg.react('📌');
    }
    return;
  }

  if (isHardStop(text)) {
    await originalMsg.react('🤷');
    return;
  }

  // ── Status message (breadcrumb trail, append-only) ───────────────────────
  const statusLines: string[] = ['⏳ Working...'];
  const statusMsg = await replyChannel.send(statusLines[0]);
  activeThinking.set(threadId, statusMsg);

  // Throttle status edits — at most once per 1.5s
  let lastStatusEdit = 0;
  let statusTimer: ReturnType<typeof setTimeout> | null = null;

  async function flushStatus() {
    lastStatusEdit = Date.now();
    statusTimer = null;
    try { await statusMsg.edit(statusLines.join('\n')); } catch { /* deleted */ }
  }

  function scheduleStatusUpdate() {
    const now = Date.now();
    if (now - lastStatusEdit >= 1500) { flushStatus(); }
    else if (!statusTimer) { statusTimer = setTimeout(flushStatus, 1500 - (now - lastStatusEdit)); }
  }

  function appendToolLine(evt: ToolEvent) {
    const emoji = toolEmoji(evt.toolName, evt.isError);
    const label = evt.argsSummary ? `\`${evt.toolName}\` ${evt.argsSummary}` : `\`${evt.toolName}\``;
    const result = evt.resultSummary ? ` → ${evt.resultSummary}` : '';
    statusLines.push(`↳ ${emoji} ${label}${result}`);
    scheduleStatusUpdate();
  }

  try {
    const response = await chat(guild, text, threadId, undefined, appendToolLine, discordCtx, contextOverride);

    if (statusTimer) { clearTimeout(statusTimer); }
    activeThinking.delete(threadId);

    if (response === '__aborted__') return;

    // Final status edit: replace spinner with checkmark
    statusLines[0] = '✅ Done';
    try { await statusMsg.edit(statusLines.join('\n')); } catch { /* ok */ }

    // Final answer as a fresh message
    const chunks = response.match(/[\s\S]{1,1990}/g) ?? ['_(no response)_'];
    for (const chunk of chunks) {
      await (replyChannel as any).send(chunk);
    }
  } catch (err) {
    if (statusTimer) { clearTimeout(statusTimer); }
    activeThinking.delete(threadId);
    const errMsg = (err as Error).message ?? String(err);
    logger.error(`Agent chat failed [thread:${threadId}]: ${errMsg}`);
    statusLines[0] = '❌ Error';
    try { await statusMsg.edit(statusLines.join('\n')); } catch { /* ok */ }
    await (replyChannel as any).send(`⚠️ ${errMsg.slice(0, 1800)}`);
  }
}

// Throttle Discord edits to at most once per 1.5 s to avoid rate limits
function makeThrottledEditor(
  getMessage: () => { edit: (s: string) => Promise<unknown> }
) {
  let lastEdit = 0;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function flush(text: string) {
    lastEdit = Date.now();
    pending = null;
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      await getMessage().edit(text + ' ▌');
    } catch { /* message may have been deleted */ }
  }

  return {
    update(text: string) {
      const now = Date.now();
      pending = text;
      if (now - lastEdit >= 1500) {
        flush(text);
      } else if (!timer) {
        timer = setTimeout(() => { if (pending) flush(pending); }, 1500 - (now - lastEdit));
      }
    },
    async finalize(text: string) {
      if (timer) { clearTimeout(timer); timer = null; }
      try {
        await getMessage().edit(text);
      } catch { /* ok */ }
    },
  };
}

function isAllowed(userId: string): boolean {
  const allowed = (process.env.CONDUCTOR_ALLOWED_USERS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return allowed.length === 0 || allowed.includes(userId);
}

async function handleDmClean(msg: Message, client: ConductorClient): Promise<void> {
  const channel = msg.channel as DMChannel;
  const botId = client.user!.id;

  // 1. Summarize current session via AI and write as a memory block
  const sessionId = resolveDmSession(msg.channelId);
  const context = loadContext(sessionId);
  const status = await channel.send('🧠 Summarizing session to memory...');

  if (context) {
    try {
      const summaryPrompt =
        'Summarize this conversation into a concise memory block. ' +
        'Extract key facts, decisions, configurations, and anything worth remembering. ' +
        'Be brief and factual — no greetings or filler. ' +
        'First line: one-sentence summary (max 120 chars). ' +
        'Then a Markdown list of key points.\n\n' +
        context;

      const summaryText = await chat(null, summaryPrompt, `__clean__${sessionId}`, undefined, undefined);
      if (summaryText && summaryText !== '__aborted__') {
        const lines = summaryText.trim().split('\n').filter(Boolean);
        const summaryLine = lines[0].replace(/^#+\s*/, '').replace(/^\*+/, '').trim().slice(0, 120);
        const filename = writeMemoryBlock(summaryText);
        appendMemorySummary(`${summaryLine} (→ ${filename})`);
        logger.info(`DM session summarized to memory block: ${filename}`);
      }
    } catch (err: any) {
      logger.warn(`Failed to summarize session: ${err.message}`);
    }
  }

  await status.edit('🗄️ Memory saved. Clearing my messages...');

  // 2. Fetch and delete all bot messages in the DM
  let deleted = 0;
  let lastId: Snowflake | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const batch: Collection<Snowflake, Message> = await channel.messages.fetch({
      limit: 100,
      ...(lastId ? { before: lastId } : {}),
    });
    if (batch.size === 0) break;

    const botMessages = batch.filter(m => m.author.id === botId && m.id !== status.id);
    for (const m of botMessages.values()) {
      await m.delete().catch(() => {});
      deleted++;
    }

    lastId = batch.last()!.id;
    if (batch.size < 100) break;
  }

  await status.edit(`✅ Done. Deleted ${deleted} of my messages. You can delete yours manually.\n_DM history archived to long-term memory._`);
}

function getManagementChannelIds(): Set<string> {
  return new Set(
    (process.env.CONDUCTOR_CHANNEL_IDS ?? '')
      .split(',').map(s => s.trim()).filter(Boolean)
  );
}

async function handleChannelClean(msg: Message, client: ConductorClient): Promise<void> {
  const channel = msg.channel as TextChannel | ThreadChannel;
  const botId = client.user!.id;
  const guild = msg.guild ?? client.guilds.cache.first() ?? null;

  const status = await channel.send('🧠 Summarizing session to memory...');

  const history = channel.isThread()
    ? await fetchThreadHistory(channel as ThreadChannel, botId)
    : await fetchChannelHistory(channel as TextChannel, botId);

  if (history) {
    try {
      const summaryPrompt =
        'Summarize this conversation into a concise memory block. ' +
        'Extract key facts, decisions, configurations, and anything worth remembering. ' +
        'Be brief and factual — no greetings or filler. ' +
        'First line: one-sentence summary (max 120 chars). ' +
        'Then a Markdown list of key points.\n\n' +
        history;
      const summaryText = await chat(null, summaryPrompt, `__clean__ch_${msg.channelId}`, undefined, undefined);
      if (summaryText && summaryText !== '__aborted__') {
        const lines = summaryText.trim().split('\n').filter(Boolean);
        const summaryLine = lines[0].replace(/^#+\s*/, '').replace(/^\*+/, '').trim().slice(0, 120);
        const filename = writeMemoryBlock(summaryText);
        appendMemorySummary(`${summaryLine} (→ ${filename})`);
        logger.info(`Channel session summarized to memory block: ${filename}`);
      }
    } catch (err: any) {
      logger.warn(`Failed to summarize session: ${err.message}`);
    }
  }

  await status.edit('🗄️ Memory saved. Clearing my messages...');

  let deleted = 0;
  let lastId: Snowflake | undefined;
  while (true) {
    const batch: Collection<Snowflake, Message> = await channel.messages.fetch({
      limit: 100,
      ...(lastId ? { before: lastId } : {}),
    });
    if (batch.size === 0) break;
    const botMessages = batch.filter(m => m.author.id === botId && m.id !== status.id);
    for (const m of botMessages.values()) {
      await m.delete().catch(() => {});
      deleted++;
    }
    lastId = batch.last()!.id;
    if (batch.size < 100) break;
  }

  await status.edit(`✅ Done. Deleted ${deleted} of my messages.\n_Conversation archived to long-term memory._`);
}

export function registerInteractionEvent(client: ConductorClient): void {

  // ── Slash commands ──────────────────────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    logger.debug(`Interaction received: type=${interaction.type} id=${interaction.id}`);
    if (!interaction.isChatInputCommand()) return;

    logger.info(`/${interaction.commandName} by ${interaction.user.username} in guild=${interaction.guildId}`);

    if (!isAllowed(interaction.user.id)) {
      logger.warn(`Blocked: ${interaction.user.username} (${interaction.user.id})`);
      await interaction.reply({ content: 'You are not authorized to use this bot.', ephemeral: true });
      return;
    }

    const command = client.commands.get(interaction.commandName);
    if (!command) {
      await interaction.reply({ content: `Unknown command \`/${interaction.commandName}\`.`, ephemeral: true });
      return;
    }

    try {
      await command.execute(interaction);
    } catch (err) {
      logger.error(`/${interaction.commandName} failed: ${(err as Error).stack ?? (err as Error).message}`);
      const payload = { content: 'An error occurred.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
      else await interaction.reply(payload);
    }
  });

  // ── Agent chat loop (shared handler for new and edited messages) ────────────
  async function handleMessage(msg: Message, source: string): Promise<void> {
    logger.info(`handleMessage [${source}] id=${msg.id} author=${msg.author?.username} bot=${msg.author?.bot}`);
    if (handledMessageIds.has(msg.id)) {
      logger.info(`handleMessage DEDUP SKIP id=${msg.id}`);
      return;
    }
    handledMessageIds.add(msg.id);
    setTimeout(() => handledMessageIds.delete(msg.id), 30_000);

    if (msg.author.bot) return;

    const botId = client.user?.id;
    const isMentioned = botId && msg.mentions.has(botId);
    const isThread = msg.channel.isThread();
    const isDM = msg.channel.type === ChannelType.DM;

    const mgmtChannelIds = getManagementChannelIds();
    const parentId = isThread ? (msg.channel as ThreadChannel).parentId ?? '' : '';
    const isMgmtChannel = mgmtChannelIds.has(msg.channelId) || mgmtChannelIds.has(parentId);

    // Respond to: DMs, explicit @mentions, or messages in a management channel.
    const shouldRespond = isDM || isMentioned || isMgmtChannel;
    if (!shouldRespond) {
      logger.debug(`Ignored message in #${msg.channelId} from ${msg.author.username}`);
      return;
    }

    if (!isAllowed(msg.author.id)) {
      logger.warn(`Blocked: ${msg.author.username} (${msg.author.id})`);
      return;
    }

    // Strip @mention tokens from text
    const text = msg.content.replace(/<@!?\d+>/g, '').trim();

    // Guild context: DMs have no guild, fall back to first available guild
    const guild = msg.guild ?? client.guilds.cache.first() ?? null;

    // ── DM path ────────────────────────────────────────────────────────────
    if (isDM) {
      if (text === '!new') {
        const sessionId = forceNewDmSession(msg.channelId);
        await msg.channel.send(`Started a new conversation session. (ID: \`${sessionId}\`)`);
        return;
      }

      if (text === '!clean') {
        const sessionId = resolveDmSession(msg.channelId);
        const hasContext = !!loadContext(sessionId);
        await msg.channel.send(
          `⚠️ **Before you clean:**\n` +
          (hasContext
            ? `📝 There is unsaved session context. It will be **archived to long-term memory** automatically.\n`
            : `ℹ️ No active session context found.\n`) +
          `\nThis will:\n` +
          `• Archive the current conversation to long-term memory\n` +
          `• Delete **all my messages** in this DM\n` +
          `• You will need to delete your own messages manually\n\n` +
          `Type \`!clean yes\` to confirm, or anything else to cancel.`
        );
        return;
      }

      if (text === '!clean yes') {
        await handleDmClean(msg, client);
        return;
      }

      if (text === '!help') {
        await msg.channel.send(
          `**MS-Conductor — DM Commands**\n\n` +
          `\`!help\` — Show this help\n` +
          `\`!new\` — Start a fresh conversation session\n` +
          `\`!clean\` — Archive conversation + delete my messages (with confirmation)\n` +
          `\`stop\` — Interrupt the running task\n\n` +
          `**Slash Commands** _(use in a guild channel)_\n` +
          `\`/model\` — Show or switch the active AI model\n` +
          `\`/topic\` — Create / manage work topics\n` +
          `\`/memory\` — Show captured memory from last topic\n` +
          `\`/status\` — List all open topics\n` +
          `\`/openclaw\` — OpenClaw config management\n` +
          `\`/setup\` — Setup wizard\n`
        );
        return;
      }
      if (!text) { await msg.channel.send('Yes? How can I help?'); return; }
      const sessionId = resolveDmSession(msg.channelId);
      logger.info(`Agent chat [dm-session:${sessionId}] from ${msg.author.username}: "${text.slice(0, 80)}"`);
      const dmCtx: DiscordContext = {
        guildId: guild?.id ?? '', guildName: guild?.name ?? '(no guild)',
        channelId: msg.channelId, channelName: 'DM', isDM: true,
      };
      await runChat(guild, text, sessionId, msg.channel as unknown as TextChannel, msg, dmCtx);
      return;
    }

    // ── Management channel path ─────────────────────────────────────────────
    // Dedicated private channel(s) configured via CONDUCTOR_CHANNEL_IDS.
    // Behaves like DM: full session, message history from Discord, deletable.
    if (isMgmtChannel && !isDM) {
      const mgmtSend = (s: string) => (msg.channel as TextChannel | ThreadChannel).send(s);
      if (text === '!new') {
        await mgmtSend(NEW_SESSION_MARKER);
        return;
      }
      if (text === '!clean') {
        await mgmtSend(
          `⚠️ This will archive the conversation to long-term memory and delete all my messages.\n` +
          `Type \`!clean yes\` to confirm.`
        );
        return;
      }
      if (text === '!clean yes') {
        await handleChannelClean(msg, client);
        return;
      }
      if (text === '!help') {
        await mgmtSend(
          `**Conductor — Channel Commands**\n\n` +
          `\`!new\` — Start a fresh session (history resets here)\n` +
          `\`!clean\` — Archive conversation + delete my messages (with confirmation)\n` +
          `\`stop\` — Interrupt the running task\n\n` +
          `**Slash Commands**\n` +
          `\`/model\` — Show or switch the active AI model\n` +
          `\`/topic\` — Create / manage work topics\n` +
          `\`/memory\` — Show captured memory\n` +
          `\`/status\` — List open topics\n` +
          `\`/openclaw\` — OpenClaw config management\n` +
          `\`/setup\` — Setup wizard\n`
        );
        return;
      }
      if (!text) { await mgmtSend('Yes?'); return; }

      const replyChannel = msg.channel as TextChannel | ThreadChannel;
      const channelName = (replyChannel as any).name ?? msg.channelId;
      const history = isThread
        ? await fetchThreadHistory(msg.channel as ThreadChannel, botId!)
        : await fetchChannelHistory(msg.channel as TextChannel, botId!);

      const threadId = `ch_${msg.channelId}`;
      logger.info(`Agent chat [mgmt-channel:${threadId}] from ${msg.author.username}: "${text.slice(0, 80)}"`);

      const mgmtCtx: DiscordContext = {
        guildId: msg.guild?.id ?? '', guildName: msg.guild?.name ?? '',
        channelId: msg.channelId, channelName, isDM: false,
      };
      if (isThread) {
        const thread = msg.channel as ThreadChannel;
        mgmtCtx.parentChannelId = thread.parentId ?? undefined;
        mgmtCtx.parentChannelName = (thread.parent as TextChannel | null)?.name ?? undefined;
      }

      await runChat(guild, text, threadId, replyChannel, msg, mgmtCtx, history);
      return;
    }

    // ── Guild path ──────────────────────────────────────────────────────────
    // Conductor is channel-silent after setup.
    // In any non-management channel, one inline response per @mention then silent.
    const replyChannel = msg.channel as TextChannel | ThreadChannel;
    const channelName = (replyChannel as any).name ?? msg.channelId;

    if (!text) {
      await replyChannel.send('Yes? (For management conversations, use the dedicated channel or DM me.)');
      return;
    }

    logger.info(`Inline reply in #${channelName} from ${msg.author.username}: "${text.slice(0, 80)}"`);

    const guildCtx: DiscordContext = {
      guildId: msg.guild!.id, guildName: msg.guild!.name,
      channelId: msg.channelId, channelName: channelName, isDM: false,
    };
    if (isThread) {
      const thread = msg.channel as ThreadChannel;
      guildCtx.parentChannelId = thread.parentId ?? undefined;
      guildCtx.parentChannelName = (thread.parent as TextChannel | null)?.name ?? undefined;
    }

    // Use a per-message context key so each @mention is independent (no session bleed)
    await runChat(guild, text, `inline-${msg.id}`, replyChannel, msg, guildCtx);
  }

  client.on(Events.MessageCreate, async (msg: Message) => {
    if (msg.partial) { try { await msg.fetch(); } catch { return; } }
    await handleMessage(msg, 'MessageCreate');
  });

  // ── Edited messages: fire if the edit newly adds an @mention ─────────────
  client.on(Events.MessageUpdate, async (oldMsg, newMsg) => {
    // If old message is partial we can't determine prior mention state — skip to avoid double-reply
    // (Discord fires MessageUpdate for embed resolution with a partial oldMsg)
    if (oldMsg.partial || newMsg.partial) return;
    const botId = client.user?.id;
    const wasAlreadyMentioned = botId && oldMsg.mentions?.has(botId);
    const isNowMentioned = botId && newMsg.mentions?.has(botId);
    if (!isNowMentioned || wasAlreadyMentioned) return;
    logger.info(`Edited message now @mentions bot from ${newMsg.author?.username}`);
    await handleMessage(newMsg as Message, 'MessageUpdate');
  });

  // Raw event logger
  client.on('raw', (packet: { t: string }) => {
    if (packet.t) logger.debug(`RAW: ${packet.t}`);
  });
}
