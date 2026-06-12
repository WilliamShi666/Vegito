// bash builtin (DESIGN §7.1): the escape hatch. Serial (write-class partition),
// execute-action permission key carrying the raw command — P4's shell tokenizer
// judges it; the tool itself stays dumb. Foreground runs block with a timeout
// (SIGTERM, then SIGKILL); background runs go into a factory-owned process
// table polled via bash_output. Exit codes are data, not exceptions — the
// model must see failure output to self-repair (L9).
//
// Containment rails: each command gets its own process group (detached) and
// kills target the whole group, so grandchildren die with the shell; output
// buffers keep at most the newest MAX_BUFFER_CHARS; a post-exit grace timer
// stops orphans that hold the stdio pipes from holding the turn hostage.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';
import type { ToolSpec } from '../spec.ts';

export interface BashIn {
  readonly command: string;
  readonly timeout?: number;
  readonly background?: boolean;
}

export interface BashOutputIn {
  readonly id: string;
}

export interface BashTools {
  readonly bashTool: ToolSpec<BashIn>;
  readonly bashOutputTool: ToolSpec<BashOutputIn>;
  /** Kill every still-running background job (session teardown). */
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 2_000;
const PIPE_GRACE_MS = 1_000;
const MAX_BUFFER_CHARS = 1_000_000;
const OVERFLOW_NOTE = '[output overflow: oldest output dropped]';

interface Job {
  readonly command: string;
  readonly child: ChildProcess;
  buffer: string;
  cursor: number;
  exitCode: number | null;
  exited: boolean;
  dropped: boolean;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal); // negative pid → the whole group
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function terminate(child: ChildProcess): void {
  killGroup(child, 'SIGTERM');
  const hardKill = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
  hardKill.unref();
  child.once('exit', () => clearTimeout(hardKill));
}

function appendCapped(job: Job, text: string): void {
  job.buffer += text;
  const excess = job.buffer.length - MAX_BUFFER_CHARS;
  if (excess > 0) {
    job.buffer = job.buffer.slice(excess);
    job.cursor = Math.max(0, job.cursor - excess);
    job.dropped = true;
  }
}

function render(stdout: string, stderr: string, suffix: string, dropped: boolean): string {
  const out = stdout.replace(/\n+$/, '');
  const err = stderr.replace(/\n+$/, '');
  const parts = [];
  if (dropped) parts.push(OVERFLOW_NOTE);
  if (out !== '') parts.push(out);
  if (err !== '') parts.push(`[stderr]\n${err}`);
  if (parts.length === 0 && suffix === '') return '(no output)';
  if (suffix !== '') parts.push(suffix);
  return parts.join('\n');
}

export function makeBashTools(): BashTools {
  const jobs = new Map<string, Job>();
  let nextId = 1;

  const bashTool = defineTool<BashIn>({
    name: 'bash',
    description:
      'Run a bash command. Blocks until it exits (default timeout 120s, max 600s) and returns ' +
      'stdout/stderr with the exit code on failure. Set background: true for long-running ' +
      'commands — you get a job id to poll with bash_output.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run via bash -c' },
        timeout: { type: 'integer', description: 'Milliseconds before the command is killed (default 120000, max 600000)' },
        background: { type: 'boolean', description: 'Run detached; poll with bash_output (default false)' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    permissionKey: (input) => ({ tool: 'bash', action: 'execute', target: input.command }),
    run: async (input, ctx) => {
      const child = spawn('bash', ['-c', input.command], {
        cwd: ctx.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group, so kills reach grandchildren
      });

      if (input.background === true) {
        const id = `b${nextId++}`;
        const job: Job = { command: input.command, child, buffer: '', cursor: 0, exitCode: null, exited: false, dropped: false };
        child.stdout?.on('data', (d: Buffer) => appendCapped(job, d.toString('utf8')));
        child.stderr?.on('data', (d: Buffer) => appendCapped(job, d.toString('utf8')));
        child.once('exit', (code) => { job.exited = true; job.exitCode = code; });
        child.once('error', () => { job.exited = true; job.exitCode = -1; });
        jobs.set(id, job);
        return { content: `background job ${id} started: ${input.command}\npoll it with bash_output {"id": "${id}"}` };
      }

      const timeoutMs = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      let stdout = '';
      let stderr = '';
      let dropped = false;
      const cap = (s: string): string => {
        if (s.length <= MAX_BUFFER_CHARS) return s;
        dropped = true;
        return s.slice(s.length - MAX_BUFFER_CHARS);
      };
      child.stdout?.on('data', (d: Buffer) => { stdout = cap(stdout + d.toString('utf8')); });
      child.stderr?.on('data', (d: Buffer) => { stderr = cap(stderr + d.toString('utf8')); });

      return await new Promise((resolvePromise) => {
        let settled = false;
        let timedOut = false;
        let aborted = false;
        let exitCode: number | null = null;

        const timer = setTimeout(() => { timedOut = true; terminate(child); }, timeoutMs);
        timer.unref();
        const onAbort = () => { aborted = true; terminate(child); };
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });

        const finish = (suffix: string) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          resolvePromise({ content: render(stdout, stderr, suffix, dropped) });
        };

        const conclude = () => {
          if (timedOut) finish(`[timed out after ${timeoutMs}ms — command was killed]`);
          else if (aborted) finish('[aborted — command was killed]');
          else if (exitCode !== 0) finish(`[exit code: ${exitCode}]`);
          else finish('');
        };

        child.once('error', (err) => finish(`[failed to spawn: ${err.message}]`));
        child.once('exit', (code) => {
          exitCode = code;
          // 'close' waits on the stdio pipes, which an escaped grandchild can
          // hold open long after the shell died — conclude shortly after exit
          // even if the pipes never close (finish is idempotent)
          const pipeGrace = setTimeout(conclude, PIPE_GRACE_MS);
          pipeGrace.unref();
        });
        child.once('close', conclude);
      });
    },
  });

  const bashOutputTool = defineTool<BashOutputIn>({
    name: 'bash_output',
    description: 'Read new output from a background bash job and its status (running / exited).',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id returned by bash with background: true' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    permissionKey: (input) => ({ tool: 'bash_output', action: 'read', target: input.id }),
    run: async (input) => {
      const job = jobs.get(input.id);
      if (job === undefined) {
        throw new ModelFacingError(`no background job ${input.id} — start one with bash {"background": true}`);
      }
      const fresh = job.buffer.slice(job.cursor);
      job.cursor = job.buffer.length;
      const note = job.dropped ? `${OVERFLOW_NOTE}\n` : '';
      job.dropped = false;
      const status = job.exited ? `[exited with code ${job.exitCode ?? 'unknown'}]` : '[still running]';
      return { content: fresh === '' ? `${note}${status}` : `${note}${fresh.replace(/\n+$/, '')}\n${status}` };
    },
  });

  return {
    bashTool,
    bashOutputTool,
    dispose: () => {
      for (const job of jobs.values()) {
        if (!job.exited) killGroup(job.child, 'SIGKILL');
      }
      jobs.clear(); // drop buffers and child refs with the session (review H1)
    },
  };
}
