import type { TextChannel, ThreadChannel } from 'discord.js';

/** Marker posted when the user runs !new — history resets after this point. */
export const NEW_SESSION_MARKER = '🆕 New session started.';

type MessageableChannel = TextChannel | ThreadChannel;

/**
 * Fetch message history from a management channel for use as LLM context.
 * Only includes messages after the most recent !new marker (if any).
 */
export async function fetchChannelHistory(
  channel: MessageableChannel,
  botId: string,
): Promise<string> {
  const fetched = await channel.messages.fetch({ limit: 100 });
  const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return formatSince(messages, botId);
}

/**
 * Fetch history for a thread inside a management channel.
 * Includes parent channel history up to thread creation, then thread messages.
 */
export async function fetchThreadHistory(
  thread: ThreadChannel,
  botId: string,
): Promise<string> {
  const parts: string[] = [];

  if (thread.parent && 'messages' in thread.parent) {
    const parentFetched = await (thread.parent as TextChannel).messages.fetch({ limit: 100 });
    const parentMessages = [...parentFetched.values()]
      .filter(m => m.createdTimestamp < (thread.createdTimestamp ?? Date.now()))
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const parentHistory = formatSince(parentMessages, botId);
    if (parentHistory) {
      parts.push('## Channel History (before this thread)\n\n' + parentHistory);
    }
  }

  const threadFetched = await thread.messages.fetch({ limit: 100 });
  const threadMessages = [...threadFetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const threadHistory = formatMessages(threadMessages, botId);
  if (threadHistory) {
    parts.push((parts.length ? '## Thread History\n\n' : '') + threadHistory);
  }

  return parts.join('\n\n');
}

/** Find the last !new marker and return only messages after it. */
function formatSince(messages: any[], botId: string): string {
  let startIdx = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].author.id === botId && messages[i].content.includes(NEW_SESSION_MARKER)) {
      startIdx = i + 1;
      break;
    }
  }
  return formatMessages(messages.slice(startIdx), botId);
}

function formatMessages(messages: any[], botId: string): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const content = msg.content?.trim();
    if (!content) continue;
    if (content.includes(NEW_SESSION_MARKER)) continue;
    // Skip status/breadcrumb messages (start with ⏳ or ✅ or ❌)
    if (/^[⏳✅❌]/.test(content)) continue;
    const role = msg.author.id === botId ? 'Conductor' : msg.author.username;
    const time = new Date(msg.createdTimestamp).toISOString();
    lines.push(`**${role}** [${time}]: ${content}`);
  }
  return lines.join('\n\n');
}
