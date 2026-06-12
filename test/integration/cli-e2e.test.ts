// P10 gate E2E (DESIGN §11): the CLI's interactive and interrupt paths driven
// entirely offline. The REPL runs through injected stdin lines plus a scripted
// wire (--script), so a full multi-turn conversation is exercised with no TTY
// and no network. Ctrl-C is modeled by aborting the dispatch signal mid-stream
// while the wire stalls, which must surface as the `interrupted` exit code
// (130) — the same seams the unit tests use, through the real dispatch router.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { scriptedText } from '../../src/providers/wire/scripted.ts';

async function scriptFile(steps: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-cli-e2e-'));
  const file = join(dir, 'script.json');
  await writeFile(file, JSON.stringify(steps), 'utf8');
  return file;
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vegito-home-'));
}

function basePorts(extra: Partial<DispatchPorts>): { out: string[]; err: string[]; ports: DispatchPorts } {
  const out: string[] = [];
  const err: string[] = [];
  const ports: DispatchPorts = {
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    homeDir: extra.homeDir ?? '/nonexistent',
    cwd: extra.cwd ?? '/nonexistent',
    signal: extra.signal ?? new AbortController().signal,
    ...extra,
  };
  return { out, err, ports };
}

test('REPL smoke: two scripted turns stream, an unknown slash command is reported, EOF exits 0', async () => {
  const h = await home();
  const file = await scriptFile([
    { kind: 'events', events: scriptedText('first answer') },
    { kind: 'events', events: scriptedText('second answer') },
  ]);
  // Drive stdin: a turn, an unknown slash command, a second turn, then EOF.
  const lines: (string | null)[] = ['hello', '/bogus', 'again', null];
  let i = 0;
  const nextLine = async (): Promise<string | null> => lines[i++] ?? null;

  const { out, ports } = basePorts({ homeDir: h, cwd: h, nextLine });
  const code = await dispatch(['repl', '--script', file, '--cwd', h], ports);
  assert.equal(code, 0);

  const text = out.join('');
  assert.match(text, /first answer/);
  assert.match(text, /second answer/);
  assert.match(text, /unknown command: \/bogus/);
});

test('Ctrl-C during a stalled model call exits 130 (interrupted)', async () => {
  const h = await home();
  // The wire stalls forever after msg_start; the abort is the only way out.
  const file = await scriptFile([
    { kind: 'stall', afterEvents: [{ t: 'msg_start', model: 'scripted-1' }] },
  ]);
  const controller = new AbortController();
  const { ports } = basePorts({ homeDir: h, cwd: h, signal: controller.signal });

  const timer = setTimeout(() => controller.abort(new Error('interrupted')), 50);
  const code = await dispatch(['run', '-p', 'hang', '--script', file, '--cwd', h], ports);
  clearTimeout(timer);

  assert.equal(code, 130, 'interrupted maps to exit 130');
});

test('a clean scripted run through dispatch exits 0 and streams text', async () => {
  const h = await home();
  const file = await scriptFile([{ kind: 'events', events: scriptedText('all good') }]);
  const { out, ports } = basePorts({ homeDir: h, cwd: h });
  const code = await dispatch(['run', '-p', 'go', '--script', file, '--cwd', h], ports);
  assert.equal(code, 0);
  assert.match(out.join(''), /all good/);
});
