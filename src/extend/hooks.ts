// P8 hook bus (DESIGN §8). Hooks are user executables wired to lifecycle
// events. The exit-code contract is the whole interface: 0 = ok (stdout is
// injected context), 2 = block (stderr returned to the model), anything else =
// warn. Per event we fire every matching hook in parallel under a hard
// timeout, then merge deny-wins: any block makes the whole dispatch a block; a
// warn downgrades from allow; otherwise allow, carrying any injected context.
//
// The bus never throws on a misbehaving hook — a hook is augmentation layered
// over the real security boundary (the permission gate), so a crashed, slow,
// or unreadable hook degrades to warn rather than wedging the loop.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { scrubbedSubprocessEnv } from '../providers/credentials.ts';

export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'Notification',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookSpec {
  readonly event: HookEvent;
  /** Path/command of the executable. */
  readonly command: string;
  /** Optional exact-match filter against payload.tool (PreToolUse/PostToolUse). */
  readonly matcher?: string;
}

export interface HookRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HookRunner {
  run(spec: HookSpec, payloadJson: string): Promise<HookRunResult>;
}

export type HookDecision = 'allow' | 'warn' | 'block';

/** Per-hook classification before the deny-wins merge. */
export type HookOutcome =
  | { readonly decision: 'allow'; readonly context?: string }
  | { readonly decision: 'warn'; readonly message: string }
  | { readonly decision: 'block'; readonly message: string };

export function classifyExit(code: number, stdout: string, stderr: string): HookOutcome {
  if (code === 0) {
    const context = stdout.trim();
    return context === '' ? { decision: 'allow' } : { decision: 'allow', context };
  }
  if (code === 2) return { decision: 'block', message: stderr.trim() };
  return { decision: 'warn', message: stderr.trim() === '' ? `hook exited ${code}` : stderr.trim() };
}

export interface DispatchResult {
  readonly decision: HookDecision;
  /** Context strings injected by allow hooks (stdout). */
  readonly contexts: readonly string[];
  /** Block/warn messages, in completion order. */
  readonly messages: readonly string[];
}

export interface HookBusOpts {
  readonly runner: HookRunner;
}

export interface HookBus {
  dispatch(event: HookEvent, payload: Record<string, unknown>): Promise<DispatchResult>;
}

function matches(spec: HookSpec, payload: Record<string, unknown>): boolean {
  if (spec.matcher === undefined) return true;
  return payload['tool'] === spec.matcher;
}

export function createHookBus(hooks: readonly HookSpec[], opts: HookBusOpts): HookBus {
  return {
    dispatch: async (event, payload) => {
      const fired = hooks.filter((h) => h.event === event && matches(h, payload));
      if (fired.length === 0) return { decision: 'allow', contexts: [], messages: [] };

      const payloadJson = JSON.stringify({ event, ...payload });
      const outcomes = await Promise.all(
        fired.map(async (spec): Promise<HookOutcome> => {
          try {
            const r = await opts.runner.run(spec, payloadJson);
            return classifyExit(r.code, r.stdout, r.stderr);
          } catch (err) {
            return { decision: 'warn', message: err instanceof Error ? err.message : String(err) };
          }
        }),
      );

      const contexts: string[] = [];
      const messages: string[] = [];
      let decision: HookDecision = 'allow';
      for (const o of outcomes) {
        if (o.decision === 'allow') {
          if (o.context !== undefined) contexts.push(o.context);
        } else {
          messages.push(o.message);
          if (o.decision === 'block') decision = 'block';
          else if (decision !== 'block') decision = 'warn';
        }
      }
      return { decision, contexts, messages };
    },
  };
}

export interface SpawnRunnerOpts {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly maxOutputBytes?: number;
}

// Loads a user-level hooks.json (e.g. ./.vegito/hooks.json): an array of
// {event, command, matcher?}. A missing file means no hooks; a malformed file
// throws — hooks are guardrails, so silently dropping them would be the unsafe
// failure mode. Relative commands resolve against the file's own directory.
// (Pack hooks take a stricter path: ExtensionRegistry.installPack re-validates
// commands to stay inside the pack root, because packs are third-party.)
export async function loadHooksFile(file: string): Promise<readonly HookSpec[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  let entries: unknown;
  try {
    entries = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(entries)) throw new Error(`${file} must be an array of hook entries`);
  const base = dirname(file);
  return entries.map((raw, i) => {
    const e = raw as { event?: unknown; command?: unknown; matcher?: unknown };
    if (typeof e.event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(e.event)) {
      throw new Error(`${file} entry ${i} has an unknown event: ${String(e.event)}`);
    }
    if (typeof e.command !== 'string' || e.command === '') {
      throw new Error(`${file} entry ${i} is missing a command`);
    }
    if (e.matcher !== undefined && typeof e.matcher !== 'string') {
      throw new Error(`${file} entry ${i} matcher must be a string`);
    }
    return {
      event: e.event as HookEvent,
      command: isAbsolute(e.command) ? e.command : resolve(base, e.command),
      ...(e.matcher === undefined ? {} : { matcher: e.matcher }),
    };
  });
}

const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

function appendCapped(current: string, chunk: Buffer | string, maxBytes: number): string {
  if (Buffer.byteLength(current, 'utf8') >= maxBytes) return current;
  const next = chunk.toString();
  const combined = current + next;
  if (Buffer.byteLength(combined, 'utf8') <= maxBytes) return combined;
  return combined.slice(0, maxBytes);
}

// Real runner: spawn the executable, write the JSON payload to stdin, capture
// stdout/stderr, and enforce a hard timeout by killing the process group. A
// timeout is reported as a non-zero exit with a "timed out" stderr so the bus
// classifies it as warn.
export function spawnHookRunner(opts: SpawnRunnerOpts = {}): HookRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    run: (spec, payloadJson) =>
      new Promise<HookRunResult>((resolve, reject) => {
        let child;
        try {
          child = spawn(spec.command, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: opts.cwd,
            env: scrubbedSubprocessEnv(),
            detached: process.platform !== 'win32',
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          if (process.platform === 'win32') {
            child.kill('SIGKILL');
          } else {
            try {
              if (child.pid === undefined) throw new Error('hook process pid unavailable');
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
          resolve({ code: 124, stdout, stderr: `${stderr}\nhook timed out after ${timeoutMs}ms` });
        }, timeoutMs);

        child.stdout.on('data', (d) => {
          stdout = appendCapped(stdout, d, maxOutputBytes);
        });
        child.stderr.on('data', (d) => {
          stderr = appendCapped(stderr, d, maxOutputBytes);
        });
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ code: code ?? 0, stdout, stderr });
        });

        child.stdin.end(payloadJson);
      }),
  };
}
