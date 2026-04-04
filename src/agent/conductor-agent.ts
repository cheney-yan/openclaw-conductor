import fs from 'fs';
import path from 'path';
import { Agent } from '@mariozechner/pi-agent-core';
import type { Guild } from 'discord.js';
import { logger } from '../logger';
import { buildTools } from './tools';
import { appendContext, parseContextMessages } from './context-store';
import { loadMemorySummary } from './long-term-memory';
import { loadModelChain, type ResolvedModel } from './provider-config';

// Model chain loaded once at startup
let _modelChain: ResolvedModel[] | null = null;
function getModelChain(): ResolvedModel[] {
  if (!_modelChain) _modelChain = loadModelChain();
  return _modelChain;
}

// ── Sticky model index ────────────────────────────────────────────────────────
// After a failure, stay on the fallback model until the retry time has elapsed.
// If the LLM returns a retry-after hint, use that; otherwise default to 30 min.
const DEFAULT_RETRY_MS = 30 * 60 * 1000; // 30 minutes

let _activeModelIndex = 0;
let _retryAfterTime = 0; // absolute timestamp when we can retry the primary

/** Parse retry-after ms from common LLM error message formats. */
function parseRetryAfterMs(errorMessage: string): number | null {
  // Try to parse JSON error body first (e.g. Anthropic/OpenAI structured errors)
  try {
    const json = JSON.parse(errorMessage.slice(errorMessage.indexOf('{')));
    const err = json?.error ?? json;
    // "resets_at": Unix timestamp (seconds)
    if (err?.resets_at) {
      const ms = err.resets_at * 1000 - Date.now();
      if (ms > 0) return ms;
    }
    // "resets_in_seconds": seconds until reset
    if (err?.resets_in_seconds) return Math.ceil(err.resets_in_seconds) * 1000;
    // OpenAI: "retry_after" seconds
    if (err?.retry_after) return Math.ceil(err.retry_after) * 1000;
  } catch { /* not JSON, fall through to regex */ }

  // Text patterns: "retry after 60 seconds", "try again in 30s", etc.
  const patterns = [
    /retry.{1,20}?(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
    /try again in\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
    /retry.after[:\s]+(\d+(?:\.\d+)?)/i,
    /retry_after[:\s"]+(\d+(?:\.\d+)?)/i,
    /cooling down.*?(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
    /wait\s+(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(errorMessage);
    if (m) return Math.ceil(parseFloat(m[1])) * 1000;
  }
  return null;
}

/** Get current active model info for display. */
export function getActiveModelInfo(): { model: ResolvedModel; index: number; retryAfterTime: number } | null {
  const chain = getModelChain();
  if (chain.length === 0) return null;
  const index = getActiveModelIndex();
  return { model: chain[index], index, retryAfterTime: _retryAfterTime };
}

/** Manually switch to a model by name or nickname. Returns the resolved model or null if not found. */
export function switchToModel(nameOrNickname: string): ResolvedModel | null {
  const chain = getModelChain();
  const idx = chain.findIndex(m => m.name === nameOrNickname || m.id === nameOrNickname);
  if (idx === -1) return null;
  _activeModelIndex = idx;
  _retryAfterTime = 0;
  logger.info(`Model manually switched to "${chain[idx].name}" (index ${idx})`);
  return chain[idx];
}

/** List all models in the chain. */
export function listChainModels(): ResolvedModel[] {
  return getModelChain();
}

function getActiveModelIndex(): number {
  if (_activeModelIndex > 0 && Date.now() >= _retryAfterTime) {
    logger.info(`Primary model cooldown elapsed — retrying from index 0`);
    _activeModelIndex = 0;
  }
  return _activeModelIndex;
}

function onModelFailure(index: number, chainLength: number, errorMessage?: string): void {
  const retryMs = (errorMessage ? parseRetryAfterMs(errorMessage) : null) ?? DEFAULT_RETRY_MS;
  _retryAfterTime = Date.now() + retryMs;
  _activeModelIndex = Math.min(index + 1, chainLength - 1);
  const retryMin = Math.round(retryMs / 60000);
  logger.info(`Model cooldown: ${retryMin}m (retry at ${new Date(_retryAfterTime).toISOString()})`);
}

// ── Per-thread interrupt tracking ────────────────────────────────────────────

const runningAgents = new Map<string, Agent>();

/** Returns true if an agent is currently running for this thread. */
export function isAgentRunning(threadId: string): boolean {
  return runningAgents.has(threadId);
}

/** Hard stop — abort the running agent immediately. Returns true if aborted. */
export function abortIfRunning(threadId: string): boolean {
  const agent = runningAgents.get(threadId);
  if (!agent) return false;
  logger.info(`Hard abort for thread:${threadId}`);
  agent.abort();
  runningAgents.delete(threadId);
  return true;
}

/**
 * Soft interrupt — inject a steering message into the running agent.
 * Delivered after the current tool call finishes, before the next LLM turn.
 * Returns true if the agent was running and steering was queued.
 */
export function steerIfRunning(threadId: string, message: string): boolean {
  const agent = runningAgents.get(threadId);
  if (!agent) return false;
  logger.info(`Steering agent for thread:${threadId}: "${message.slice(0, 60)}"`);
  agent.steer({ role: 'user', content: `[User note mid-task]: ${message}`, timestamp: Date.now() } as any);
  return true;
}

// ── Model / prompt helpers ────────────────────────────────────────────────────

function loadSystemPrompt(): string {
  const agentMdPath = path.resolve(process.cwd(), 'AGENT.md');
  if (!fs.existsSync(agentMdPath)) {
    logger.warn('AGENT.md not found, using minimal system prompt');
    return 'You are OpenClaw Conductor, an AI agent managing a Discord server.';
  }
  return fs.readFileSync(agentMdPath, 'utf-8');
}

/** System prompt block 1: AGENT.md only. Never changes → cache BP 1. */
function loadAgentSystemPrompt(): string {
  return loadSystemPrompt();
}

/** System prompt block 2: Memory summary. Grows one line per session → cache BP 2. */
function loadMemoryBlock(): string {
  const summary = loadMemorySummary();
  if (!summary) return '';
  return `## Memory Summary\n\n${summary}`;
}

/**
 * Build onPayload hook that splits system prompt into two cache breakpoints:
 *   block 1 → AGENT.md       (cache_control: ephemeral) — BP 1, never changes
 *   block 2 → SUMMARY.md     (cache_control: ephemeral) — BP 2, grows slowly
 *
 * Prior conversation from local context files is passed as initialState.messages.
 * Channel history (contextOverride) is injected as an additional system block.
 * For non-Anthropic providers the payload has no system array — returned unchanged.
 */
function buildOnPayload(
  memorySummary: string,
  contextOverride?: string,
): ((payload: unknown, model: any) => unknown) | undefined {
  if (!memorySummary && !contextOverride) return undefined;
  return (payload: any) => {
    if (!payload || typeof payload !== 'object') return payload;
    if (!Array.isArray(payload.system)) return payload;
    const cacheControl = { type: 'ephemeral' };
    const block1 = payload.system.map((b: any) => ({ ...b, cache_control: cacheControl }));
    const extra: any[] = [];
    if (memorySummary) {
      extra.push({ type: 'text', text: memorySummary, cache_control: cacheControl });
    }
    if (contextOverride) {
      extra.push({ type: 'text', text: `## Channel History\n\n${contextOverride}` });
    }
    return { ...payload, system: [...block1, ...extra] };
  };
}

function extractText(msg: any): string {
  if (Array.isArray(msg?.content)) {
    const text = msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
    if (text) return text;
  }
  if (typeof msg?.content === 'string' && msg.content) return msg.content;
  if (msg?.errorMessage) return `⚠️ LLM error: ${msg.errorMessage}`;
  if (msg?.stopReason === 'error') return '⚠️ LLM returned an error with no message';
  return '';
}

// ── Main chat function ────────────────────────────────────────────────────────

function summarizeArgs(args: any): string {
  if (!args || typeof args !== 'object') return '';
  // For openclaw_cli, show the command
  if (Array.isArray(args.args)) return args.args.join(' ').slice(0, 60);
  // For file ops, show the path
  if (args.relative_path) return args.relative_path;
  if (args.channel_id) return `#${args.channel_id}`;
  if (args.key_path) return args.key_path;
  // Generic: first string value
  const first = Object.values(args).find(v => typeof v === 'string') as string | undefined;
  return first?.slice(0, 60) ?? '';
}

export interface DiscordContext {
  guildId: string;
  guildName: string;
  channelId: string;       // thread ID if in a thread, DM channel ID if DM
  channelName: string;
  parentChannelId?: string;  // set when inside a thread
  parentChannelName?: string;
  isDM: boolean;
}

function buildContextSection(ctx: DiscordContext): string {
  const lines = [
    '## Current Discord Context',
    `- Guild: **${ctx.guildName}** (ID: \`${ctx.guildId}\`)`,
  ];
  if (ctx.isDM) {
    lines.push(`- Conversation type: Direct Message`);
    lines.push(`- DM Channel ID: \`${ctx.channelId}\``);
  } else if (ctx.parentChannelId) {
    lines.push(`- Thread: **${ctx.channelName}** (ID: \`${ctx.channelId}\`)`);
    lines.push(`- Parent channel: **#${ctx.parentChannelName}** (ID: \`${ctx.parentChannelId}\`)`);
    lines.push(`- When the user says "this channel" or "this thread", they mean thread \`${ctx.channelId}\`.`);
  } else {
    lines.push(`- Channel: **#${ctx.channelName}** (ID: \`${ctx.channelId}\`)`);
    lines.push(`- When the user says "this channel", they mean \`${ctx.channelId}\`.`);
  }
  return lines.join('\n');
}

export interface ToolEvent {
  toolName: string;
  argsSummary: string;
  resultSummary: string;
  isError: boolean;
}

export async function chat(
  guild: Guild | null,
  userMessage: string,
  threadId: string,
  onUpdate?: (partial: string) => void,
  onToolEnd?: (evt: ToolEvent) => void,
  discordCtx?: DiscordContext,
  contextOverride?: string,
): Promise<string> {
  const systemPrompt = loadAgentSystemPrompt();
  const memorySummary = loadMemoryBlock();
  // Channel sessions: contextOverride is plain text history → injected as system block
  // DM sessions: structured messages from local context file → passed as initialState.messages
  const priorMessages = contextOverride !== undefined ? [] : parseContextMessages(threadId);
  const formattedMessages = priorMessages.map(m =>
    m.role === 'assistant'
      ? { ...m, content: [{ type: 'text', text: m.content }] }
      : m
  );
  const tools = buildTools(guild, discordCtx);
  const modelChain = getModelChain();

  let lastError: Error | undefined;

  const startIndex = getActiveModelIndex();
  for (let i = startIndex; i < modelChain.length; i++) {
    const model = modelChain[i];
    if (i > startIndex) {
      logger.warn(`Falling back to model "${model.name}" (attempt ${i - startIndex + 1})`);
    } else if (i > 0) {
      logger.info(`Using sticky model "${model.name}" (primary still in cooldown)`);
    }

    const onPayload = buildOnPayload(memorySummary, contextOverride);
    const agent = new Agent({
      initialState: { systemPrompt, model, tools, messages: formattedMessages as any[] },
      getApiKey: () => model.apiKey,
      ...(onPayload ? { onPayload } : {}),
    });

    runningAgents.set(threadId, agent);

    let response = '';
    let aborted = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = agent.subscribe((event) => {
          if (event.type !== 'message_update') logger.debug(`Agent event: ${event.type}`);

          if (event.type === 'tool_execution_end') {
            const e = event as any;
            const raw: string = e.result?.content?.[0]?.text ?? JSON.stringify(e.result ?? '');
            const firstLine = raw.split('\n')[0].trim();
            const argsSummary = summarizeArgs(e.args);
            onToolEnd?.({
              toolName: e.toolName,
              argsSummary,
              resultSummary: firstLine.slice(0, 80),
              isError: !!e.isError,
            });
          }

          if (event.type === 'message_update') {
            const msg = (event as any).message;
            if (msg?.role === 'assistant') {
              const text = extractText(msg);
              if (text) { response = text; onUpdate?.(text); }
            }
          }

          if (event.type === 'message_end') {
            const msg = (event as any).message;
            logger.debug(`  message_end role=${msg?.role} stopReason=${msg?.stopReason}`);
            if (msg?.role === 'assistant') {
              if (msg?.stopReason === 'aborted') {
                aborted = true;
              } else if (msg?.stopReason === 'error') {
                // LLM-level error — treat as failure so fallback chain kicks in
                unsubscribe();
                reject(new Error(msg?.errorMessage ?? 'LLM error'));
              } else {
                const text = extractText(msg);
                if (text) response = text;
              }
            }
          }

          if (event.type === 'agent_end') {
            const messages: any[] = (event as any).messages ?? [];
            if (!response && !aborted) {
              const last = [...messages].reverse().find((m: any) => m.role === 'assistant');
              if (last) response = extractText(last);
            }
            unsubscribe();
            resolve();
          }
        });

        agent.prompt(userMessage).catch((err: Error) => {
          logger.error(`agent.prompt threw: ${err.message}`);
          unsubscribe();
          reject(err);
        });
      });

      // Success
      runningAgents.delete(threadId);

      if (aborted) {
        logger.info(`Agent aborted [thread:${threadId}]`);
        return '__aborted__';
      }

      const finalResponse = response || '(no response)';
      // Skip local context file when channel history is the source of truth
      if (contextOverride === undefined) appendContext(threadId, userMessage, finalResponse);
      logger.info(`Agent responded [thread:${threadId}] via "${model.name}": "${finalResponse.slice(0, 80)}"`);
      return finalResponse;

    } catch (err) {
      runningAgents.delete(threadId);
      lastError = err as Error;
      logger.warn(`Model "${model.name}" failed [thread:${threadId}]: ${lastError.message}`);
      onModelFailure(i, modelChain.length, lastError.message);
      // Continue to next model in chain
    }
  }

  throw lastError ?? new Error('All models in chain failed');
}
