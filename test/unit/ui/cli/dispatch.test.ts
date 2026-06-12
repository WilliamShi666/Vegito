// P10 dispatch: argv → effect. dispatch() is the one impure entry the bin
// calls; it parses, routes, and returns a process exit code. Every effect it
// needs (stdout/stderr, home/cwd, the turn abort signal, REPL input) is an
// injected port, so the whole CLI runs offline here through a ScriptedWire
// fixture — no network, no real TTY, no environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, type DispatchPorts } from '../../../../src/ui/cli/dispatch.ts';
import { scriptedText } from '../../../../src/providers/wire/scripted.ts';

function collector(): { out: string[]; err: string[]; ports: (extra: Partial<DispatchPorts>) => DispatchPorts } {
  const out: string[] = [];
  const err: string[] = [];
  const ports = (extra: Partial<DispatchPorts>): DispatchPorts => ({
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    homeDir: extra.homeDir ?? '/nonexistent-home',
    cwd: extra.cwd ?? '/nonexistent-cwd',
    signal: new AbortController().signal,
    ...extra,
  });
  return { out, err, ports };
}

async function scriptFile(steps: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-disp-'));
  const file = join(dir, 'script.json');
  await writeFile(file, JSON.stringify(steps), 'utf8');
  return file;
}

test('--version prints version and exits 0', async () => {
  const { out, ports } = collector();
  const code = await dispatch(['--version'], ports({}));
  assert.equal(code, 0);
  assert.match(out.join(''), /vegito \d+\.\d+\.\d+/);
});

test('help prints usage and exits 0', async () => {
  const { out, ports } = collector();
  const code = await dispatch(['help'], ports({}));
  assert.equal(code, 0);
  assert.match(out.join('').toLowerCase(), /usage/);
});

test('unknown command writes to stderr and exits 2', async () => {
  const { err, ports } = collector();
  const code = await dispatch(['bogus-cmd'], ports({}));
  assert.equal(code, 2);
  assert.match(err.join(''), /unknown command/);
});

test('invalid --mode exits 2 without running', async () => {
  const { err, ports } = collector();
  const code = await dispatch(['run', '-p', 'hi', '--mode', 'wat'], ports({}));
  assert.equal(code, 2);
  assert.match(err.join(''), /invalid --mode/);
});

test('run with a scripted wire streams the assistant text and exits 0', async () => {
  const file = await scriptFile([{ kind: 'events', events: scriptedText('hello from vegito') }]);
  const { out, ports } = collector();
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const code = await dispatch(['run', '-p', 'say hi', '--script', file], ports({ homeDir: home, cwd: home }));
  assert.equal(code, 0);
  assert.match(out.join(''), /hello from vegito/);
});

test('run --json emits parseable LoopEvent lines including turn_end', async () => {
  const file = await scriptFile([{ kind: 'events', events: scriptedText('hi') }]);
  const { out, ports } = collector();
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const code = await dispatch(['run', '-p', 'hi', '--script', file, '--json'], ports({ homeDir: home, cwd: home }));
  assert.equal(code, 0);
  const lines = out.join('').split('\n').filter((l) => l.trim() !== '');
  const events = lines.map((l) => JSON.parse(l) as { t: string });
  assert.ok(events.some((e) => e.t === 'turn_end'), 'a turn_end event is emitted');
  assert.ok(events.some((e) => e.t === 'text_delta'), 'a text_delta event is emitted');
});

test('sessions list on an empty store exits 0 and never throws', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const { ports } = collector();
  const code = await dispatch(['sessions', 'list'], ports({ homeDir: home, cwd: home }));
  assert.equal(code, 0);
});

test('packs validate without a path exits 2', async () => {
  const { err, ports } = collector();
  const code = await dispatch(['packs', 'validate'], ports({}));
  assert.equal(code, 2);
  assert.match(err.join(''), /pack directory/);
});

test('packs validate on a real pack reports its name and exits 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-pack-'));
  await mkdir(join(dir, 'mypack'), { recursive: true });
  await writeFile(
    join(dir, 'mypack', 'pack.json'),
    JSON.stringify({ schema: 1, name: 'mypack', version: '1.0.0', description: 'a pack' }),
    'utf8',
  );
  const { out, ports } = collector();
  const code = await dispatch(['packs', 'validate', join(dir, 'mypack')], ports({}));
  assert.equal(code, 0);
  assert.match(out.join(''), /mypack/);
});

test('run streams a tool call through the real registry to completion', async () => {
  // model asks to write a file, then (next call) ends the turn — exercises the
  // executor + permission engine + gate end-to-end via the scripted wire.
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const target = join(home, 'note.txt');
  const steps = [
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'tool_call', callId: 'c1', name: 'write', input: { path: target, content: 'hi' } },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    { kind: 'events', events: scriptedText('done') },
  ];
  const file = await scriptFile(steps);
  const { out, ports } = collector();
  const code = await dispatch(
    ['run', '-p', 'write a note', '--script', file, '--mode', 'bypass', '--cwd', home],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(code, 0);
  assert.match(out.join(''), /done/);
});
