import { Type } from '@sinclair/typebox';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { logger } from '../logger';
import { readOpenClawConfig } from '../openclaw/config-reader';
import {
  snapshotBefore,
  listSnapshots,
  diffSnapshot,
  restoreSnapshot,
} from './snapshot-store';

const execFileAsync = promisify(execFile);

function ok(text: string): AgentToolResult<undefined> {
  return { content: [{ type: 'text', text }], details: undefined };
}

function getOpenClawBin(): string {
  return process.env.OPENCLAW_BIN ?? 'openclaw';
}

function getOpenClawRoot(): string | undefined {
  return process.env.OPENCLAW_ROOT;
}

function getConfigPath(): string {
  const root = getOpenClawRoot();
  if (root) return path.join(root, 'openclaw.json');
  return path.join(process.env.HOME ?? '~', '.openclaw', 'openclaw.json');
}

// Subcommands that are destructive or irreversible — require explicit allow
const BLOCKED_SUBCOMMANDS = ['reset', 'completion'];

// Subcommand patterns that modify state → auto-snapshot before running
const WRITE_PATTERNS: RegExp[] = [
  /^config\s+set/,
  /^agents\s+(add|delete|bind|unbind)/,
  /^channels\s+.*(set|add|remove|enable|disable)/,
  /^hooks\s+(add|remove|set)/,
  /^plugins\s+(install|remove)/,
];

async function runOpenclaw(args: string[], timeoutMs = 15000): Promise<string> {
  const bin = getOpenClawBin();
  logger.info(`openclaw ${args.join(' ')}`);

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      env: { ...process.env },
      maxBuffer: 1024 * 512, // 512 KB
    });
    const out = [stdout, stderr].filter(Boolean).join('\n').trim();
    return out || '(no output)';
  } catch (err: any) {
    // execFile throws on non-zero exit; include stdout+stderr in the result
    const out = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return `Exit ${err.code ?? '?'}: ${out || err.message}`;
  }
}

export function buildOpenClawTools(): AgentTool<any>[] {
  return [

    // ── Primary: general CLI runner ──────────────────────────────────────────
    {
      name: 'openclaw_cli',
      label: 'Run OpenClaw CLI',
      description:
        'Run any `openclaw` CLI command and return its output. ' +
        'Pass the subcommand and arguments as a list, e.g. ["agents", "list"] or ' +
        '["config", "set", "channels.discord.enabled", "true"]. ' +
        'Use this as the primary way to inspect and configure OpenClaw. ' +
        '\n\nWhen something is not working or you get an unexpected error, ALWAYS run ' +
        '["doctor"] first — it checks connectivity, credentials, config validity, and ' +
        'prints actionable fix suggestions. Run ["doctor", "--fix"] to auto-fix common issues. ' +
        'If doctor does not resolve it, describe the error to the user and suggest they search ' +
        'for the exact error message on https://docs.openclaw.ai or the OpenClaw Discord community.',
      parameters: Type.Object({
        args: Type.Array(Type.String(), {
          description: 'CLI arguments after `openclaw`, e.g. ["agents", "list", "--json"]',
        }),
        timeout_ms: Type.Optional(Type.Number({
          description: 'Timeout in ms. Default 15000.',
        })),
      }),
      execute: async (_id, p: { args: string[]; timeout_ms?: number }) => {
        if (!p.args?.length) return ok('No arguments provided.');

        const sub = p.args[0];
        if (BLOCKED_SUBCOMMANDS.includes(sub)) {
          return ok(`Subcommand "${sub}" is blocked for safety. Ask the user to run it manually.`);
        }

        // Auto-snapshot before any write operation
        const argStr = p.args.join(' ');
        const isWrite = WRITE_PATTERNS.some(re => re.test(argStr));
        if (isWrite) {
          const hash = await snapshotBefore(`openclaw ${argStr}`);
          if (hash) logger.info(`Auto-snapshot ${hash} before: openclaw ${argStr}`);
        }

        const output = await runOpenclaw(p.args, p.timeout_ms ?? 15000);
        return ok(output);
      },
    },

    // ── Read: inspect openclaw config as raw JSON ────────────────────────────
    {
      name: 'openclaw_read_config',
      label: 'Read OpenClaw Config',
      description:
        'Read the raw openclaw.json config file. Use this to inspect current settings ' +
        'when CLI output is insufficient or to understand the full config structure. ' +
        'Secrets (tokens, API keys) are included — do not echo them to the user.',
      parameters: Type.Object({}),
      execute: async () => {
        const configPath = getConfigPath();
        try {
          const config = readOpenClawConfig(configPath);
          // Redact secrets before returning
          const safe = JSON.parse(JSON.stringify(config));
          redactSecrets(safe);
          return ok(JSON.stringify(safe, null, 2));
        } catch (err: any) {
          return ok(`Could not read config at ${configPath}: ${err.message}`);
        }
      },
    },

    // ── Read: inspect any file inside openclaw root or agent workspace ───────
    {
      name: 'openclaw_read_file',
      label: 'Read OpenClaw File',
      description:
        'Read a file from within the OpenClaw root directory (~/.openclaw by default) ' +
        'or an agent workspace. Use to inspect SOUL.md, hooks, skills, or other config files. ' +
        'Path must be relative to the openclaw root.',
      parameters: Type.Object({
        relative_path: Type.String({
          description: 'Path relative to openclaw root, e.g. "agents/my-agent/SOUL.md" or "openclaw.json"',
        }),
      }),
      execute: async (_id, p: { relative_path: string }) => {
        const root = getOpenClawRoot() ?? path.join(process.env.HOME ?? '~', '.openclaw');
        // Prevent path traversal
        const resolved = path.resolve(root, p.relative_path);
        if (!resolved.startsWith(path.resolve(root))) {
          return ok('Path traversal not allowed.');
        }
        if (!fs.existsSync(resolved)) {
          return ok(`File not found: ${resolved}`);
        }
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          const entries = fs.readdirSync(resolved).map(e => {
            const ep = path.join(resolved, e);
            return fs.statSync(ep).isDirectory() ? `${e}/` : e;
          });
          return ok(`Directory listing of ${p.relative_path}:\n${entries.join('\n')}`);
        }
        if (stat.size > 100_000) {
          return ok(`File is too large (${stat.size} bytes). Read it in parts or use the CLI.`);
        }
        const content = fs.readFileSync(resolved, 'utf-8');
        return ok(content);
      },
    },

    // ── Fallback: directly write a single key to openclaw.json ──────────────
    {
      name: 'openclaw_write_config_key',
      label: 'Write OpenClaw Config Key (Direct)',
      description:
        'FALLBACK ONLY — directly patch a key in openclaw.json using dot-notation. ' +
        'Prefer `openclaw_cli` with ["config", "set", ...] instead. ' +
        'Use this only if the CLI is unavailable or the key is not supported by the CLI. ' +
        'Always creates a timestamped backup before writing.',
      parameters: Type.Object({
        key_path: Type.String({
          description: 'Dot-notation path, e.g. "channels.discord.enabled"',
        }),
        value: Type.String({
          description: 'JSON value as a string, e.g. "true", "\\"hello\\"", or "{\\"allow\\":true}"',
        }),
      }),
      execute: async (_id, p: { key_path: string; value: string }) => {
        const configPath = getConfigPath();
        let parsed: any;
        try {
          parsed = JSON.parse(p.value);
        } catch {
          return ok(`Invalid JSON value: ${p.value}`);
        }

        try {
          const config = readOpenClawConfig(configPath);
          // Git snapshot before direct write
          await snapshotBefore(`direct config write: ${p.key_path}`);

          // Set nested key
          const keys = p.key_path.split('.');
          let cursor: any = config;
          for (let i = 0; i < keys.length - 1; i++) {
            if (cursor[keys[i]] === undefined) cursor[keys[i]] = {};
            cursor = cursor[keys[i]];
          }
          cursor[keys[keys.length - 1]] = parsed;

          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
          logger.info(`Direct config write: ${p.key_path} = ${p.value}`);
          return ok(`Set ${p.key_path} = ${p.value}`);
        } catch (err: any) {
          return ok(`Failed: ${err.message}`);
        }
      },
    },

    // ── Write: write any file inside openclaw root ───────────────────────────
    {
      name: 'openclaw_write_file',
      label: 'Write OpenClaw File',
      description:
        'Write (create or overwrite) a text file within the OpenClaw root directory (~/.openclaw by default) ' +
        'or an agent workspace. Use this to edit SOUL.md, hooks, skills, or any other agent config files. ' +
        'Path must be relative to the openclaw root. Auto-snapshots before writing so changes are undoable. ' +
        'Examples: "agents/luna/SOUL.md", "agents/luna/hooks/post-message.sh".',
      parameters: Type.Object({
        relative_path: Type.String({
          description: 'Path relative to openclaw root, e.g. "agents/luna/SOUL.md"',
        }),
        content: Type.String({
          description: 'Full UTF-8 text content to write to the file',
        }),
      }),
      execute: async (_id, p: { relative_path: string; content: string }) => {
        const root = getOpenClawRoot() ?? path.join(process.env.HOME ?? '~', '.openclaw');
        const resolved = path.resolve(root, p.relative_path);
        if (!resolved.startsWith(path.resolve(root))) {
          return ok('Path traversal not allowed.');
        }
        try {
          await snapshotBefore(`file write: ${p.relative_path}`);
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, p.content, 'utf-8');
          logger.info(`Wrote file: ${resolved}`);
          return ok(`Written: ${p.relative_path} (${p.content.length} chars)`);
        } catch (err: any) {
          return ok(`Failed to write ${p.relative_path}: ${err.message}`);
        }
      },
    },

    // ── Snapshot: list history ───────────────────────────────────────────────
    {
      name: 'openclaw_snapshot_list',
      label: 'List OpenClaw Snapshots',
      description:
        'List recent snapshots (git log) of the OpenClaw config taken before write operations. ' +
        'Each entry shows a short hash, timestamp, and the operation that triggered it. ' +
        'Use hashes with openclaw_snapshot_restore to roll back.',
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: 'Max entries to show. Default 20.' })),
      }),
      execute: async (_id, p: { limit?: number }) => {
        const log = await listSnapshots(p.limit ?? 20);
        return ok(log);
      },
    },

    // ── Snapshot: diff ───────────────────────────────────────────────────────
    {
      name: 'openclaw_snapshot_diff',
      label: 'Show OpenClaw Snapshot Diff',
      description:
        'Show what changed in a specific snapshot commit vs the one before it. ' +
        'Pass a short hash from openclaw_snapshot_list.',
      parameters: Type.Object({
        hash: Type.String({ description: 'Short commit hash from snapshot list' }),
      }),
      execute: async (_id, p: { hash: string }) => {
        const diff = await diffSnapshot(p.hash);
        return ok(diff.slice(0, 3000));
      },
    },

    // ── Snapshot: restore ────────────────────────────────────────────────────
    {
      name: 'openclaw_snapshot_restore',
      label: 'Restore OpenClaw Snapshot',
      description:
        'Restore openclaw.json and agent files from a previous snapshot. ' +
        'IMPORTANT: automatically takes a snapshot of current state first, so this is undoable. ' +
        'Pass a short hash from openclaw_snapshot_list. ' +
        'Always confirm with the user before calling this.',
      parameters: Type.Object({
        hash: Type.String({ description: 'Short commit hash to restore from' }),
      }),
      execute: async (_id, p: { hash: string }) => {
        const result = await restoreSnapshot(p.hash);
        logger.info(`Snapshot restored: ${p.hash}`);
        return ok(result);
      },
    },

  ];
}

// Redact known secret fields recursively
function redactSecrets(obj: any): void {
  if (typeof obj !== 'object' || !obj) return;
  const secretKeys = ['botToken', 'appToken', 'apiKey', 'token', 'secret', 'password'];
  for (const key of Object.keys(obj)) {
    if (secretKeys.some(s => key.toLowerCase().includes(s))) {
      obj[key] = '[REDACTED]';
    } else {
      redactSecrets(obj[key]);
    }
  }
}
