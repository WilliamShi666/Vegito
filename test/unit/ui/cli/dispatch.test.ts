// P10 dispatch: argv → effect. dispatch() is the one impure entry the bin
// calls; it parses, routes, and returns a process exit code. Every effect it
// needs (stdout/stderr, home/cwd, the turn abort signal, REPL input) is an
// injected port, so the whole CLI runs offline here through a ScriptedWire
// fixture — no network, no real TTY, no environment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
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

test('packs validate on a semantically broken pack lists problems and exits 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-pack-'));
  const root = join(dir, 'broken');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'a.md'), 'agent a prompt', 'utf8');
  await writeFile(join(root, 'b.md'), 'agent b prompt', 'utf8');
  await writeFile(
    join(root, 'pack.json'),
    JSON.stringify({
      schema: 1,
      name: 'broken',
      version: '1.0.0',
      description: 'duplicate agents trip the semantic validator',
      agents: [
        { name: 'dup', model: 'tier:smart', tools: [], prompt: './a.md' },
        { name: 'dup', model: 'tier:smart', tools: [], prompt: './b.md' },
      ],
      modelTiers: { smart: 'a capable tier' },
    }),
    'utf8',
  );
  const { err, ports } = collector();
  const code = await dispatch(['packs', 'validate', root], ports({}));
  assert.equal(code, 1);
  assert.match(err.join(''), /problem\(s\)/);
  assert.match(err.join(''), /dup/);
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
        { t: 'tool_call', callId: 'c1', name: 'write', input: { file_path: target, content: 'hi' } },
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
  assert.equal(await readFile(target, 'utf8'), 'hi');
});

test('run fires .vegito/hooks.json: a PreToolUse block hook stops the write', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const target = join(home, 'note.txt');
  await mkdir(join(home, '.vegito'), { recursive: true });
  const guard = join(home, '.vegito', 'guard.sh');
  await writeFile(guard, '#!/usr/bin/env bash\necho "writes are frozen" >&2\nexit 2\n', 'utf8');
  await chmod(guard, 0o755);
  await writeFile(
    join(home, '.vegito', 'hooks.json'),
    JSON.stringify([{ event: 'PreToolUse', command: './guard.sh', matcher: 'write' }]),
    'utf8',
  );
  const steps = [
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'tool_call', callId: 'c1', name: 'write', input: { file_path: target, content: 'hi' } },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    { kind: 'events', events: scriptedText('acknowledged the freeze') },
  ];
  const file = await scriptFile(steps);
  const { out, ports } = collector();
  const code = await dispatch(
    ['run', '-p', 'write a note', '--script', file, '--mode', 'bypass', '--cwd', home],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(code, 0);
  assert.match(out.join(''), /acknowledged the freeze/);
  await assert.rejects(() => readFile(target, 'utf8'), 'the hook must stop the write before it happens');
});

test('run aborts loud when .vegito/hooks.json is malformed (guardrails must not silently drop)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  await mkdir(join(home, '.vegito'), { recursive: true });
  await writeFile(join(home, '.vegito', 'hooks.json'), '{ not json', 'utf8');
  const file = await scriptFile([{ kind: 'events', events: scriptedText('never reached') }]);
  const { err, ports } = collector();
  const code = await dispatch(
    ['run', '-p', 'hi', '--script', file, '--cwd', home],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(code, 1);
  assert.match(err.join(''), /hooks\.json/);
});

test('forge --offline with flags writes a validated pack and exits 0', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-forge-'));
  const out = join(home, 'mypack');
  const { out: stdout, ports } = collector();
  const code = await dispatch(
    ['forge', '--offline', '--archetype', 'tutor-team', '--domain', 'IELTS writing', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(code, 0);
  assert.match(stdout.join(''), /forged pack/);
  assert.match(stdout.join(''), /validated clean/);
});

test('forge --offline without a domain exits 2 with guidance', async () => {
  const { err, ports } = collector();
  const code = await dispatch(['forge', '--offline', '--archetype', 'review-team'], ports({}));
  assert.equal(code, 2);
  assert.match(err.join(''), /domain/);
});

test('forge --offline with an unknown archetype exits 2', async () => {
  const { err, ports } = collector();
  const code = await dispatch(['forge', '--offline', '--archetype', 'nope', '--domain', 'x'], ports({}));
  assert.equal(code, 2);
  assert.match(err.join(''), /unknown archetype/);
});

test('forge --from infers archetype and domain from a docs file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-forge-'));
  const docs = join(home, 'brief.md');
  await writeFile(docs, '# Pull Request Reviewer\nWe audit code for security and correctness issues.', 'utf8');
  const out = join(home, 'forged');
  const { out: stdout, ports } = collector();
  const code = await dispatch(
    ['forge', '--offline', '--from', docs, '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(code, 0);
  assert.match(stdout.join(''), /review-team/);
});

test('forge interactive uses the nextLine port to interview', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-forge-'));
  const out = join(home, 'interviewed');
  const answers = ['content-studio', 'blog posts', '', null];
  let i = 0;
  const nextLine = async (): Promise<string | null> => answers[i++] ?? null;
  const { out: stdout, ports } = collector();
  // no --offline, no --domain, no --from → interactive path. --script keeps the
  // online enrichment offline (deterministic), so the test needs no network.
  const script = await scriptFile([{ kind: 'events', events: scriptedText('A refined studio persona.') }]);
  const code = await dispatch(
    ['forge', '--out', out, '--script', script],
    ports({ homeDir: home, cwd: home, nextLine }),
  );
  assert.equal(code, 0);
  assert.match(stdout.join(''), /content-studio/);
});

