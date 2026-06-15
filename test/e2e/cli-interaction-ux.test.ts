import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { scriptedText } from '../../src/providers/wire/scripted.ts';

function portsFor(extra: Partial<DispatchPorts>): { readonly out: string[]; readonly err: string[]; readonly ports: DispatchPorts } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ports: {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      homeDir: extra.homeDir ?? '/nonexistent-home',
      cwd: extra.cwd ?? '/nonexistent-cwd',
      signal: new AbortController().signal,
      ...extra,
    },
  };
}

async function scriptFile(root: string, steps: unknown): Promise<string> {
  const file = join(root, `script-${Math.random().toString(16).slice(2)}.json`);
  await writeFile(file, JSON.stringify(steps), 'utf8');
  return file;
}

test('REPL permission prompt is distinct and accepts the short allow alias', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-cli-ux-perm-'));
  const target = join(home, 'note.txt');
  const script = await scriptFile(home, [
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'tool_call', callId: 'c1', name: 'write', input: { file_path: target, content: 'allowed by alias' } },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    { kind: 'events', events: scriptedText('write complete') },
  ]);
  const lines: (string | null)[] = ['write the note', 'a', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: home, nextLine: async () => lines[index++] ?? null });

  const code = await dispatch(['repl', '--script', script, '--cwd', home], run.ports);

  assert.equal(code, 0);
  const text = run.out.join('');
  assert.match(text, /Permission request/);
  assert.match(text, /Tool: write/);
  assert.match(text, /Action: write/);
  assert.match(text, /permission>/);
  assert.match(text, /write complete/);
  assert.equal(await readFile(target, 'utf8'), 'allowed by alias');
});

test('missing skill tool failure stays recoverable and renders without a Node stack trace', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-cli-ux-skill-'));
  const script = await scriptFile(home, [
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'tool_call', callId: 'c1', name: 'skill', input: { name: 'gitnexus-exploring' } },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    { kind: 'events', events: scriptedText('I can continue without that skill.') },
  ]);
  const lines: (string | null)[] = ['use gitnexus-exploring', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: home, nextLine: async () => lines[index++] ?? null });

  const code = await dispatch(['repl', '--script', script, '--cwd', home], run.ports);

  assert.equal(code, 0);
  const text = run.out.join('');
  assert.match(text, /Tool failed: skill/);
  assert.match(text, /no skill named "gitnexus-exploring"/);
  assert.match(text, /I can continue without that skill/);
  assert.doesNotMatch(`${text}\n${run.err.join('')}`, /ModelFacingError|at Object\.run|\.js:\d+/);
});

test('/packs lists generated harnesses without a model turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-cli-ux-packs-'));
  const pack = join(home, 'generated', 'demo-live');
  await writeFile(join(home, 'placeholder'), 'x', 'utf8');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(join(pack, 'commands'), { recursive: true }));
  await writeFile(join(pack, 'commands', 'demo-start.md'), 'Demo $ARGUMENTS', 'utf8');
  await writeFile(
    join(pack, 'pack.json'),
    JSON.stringify({
      schema: 1,
      name: 'demo-generated-harness',
      version: '1.0.0',
      description: 'A generated demo harness.',
      commands: './commands',
      grants: [],
      agents: [],
      rubrics: [],
      modelTiers: {},
    }),
    'utf8',
  );
  const script = await scriptFile(home, [{ kind: 'events', events: scriptedText('model should not run') }]);
  const lines: (string | null)[] = ['/packs', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: home, nextLine: async () => lines[index++] ?? null });

  const code = await dispatch(['repl', '--script', script, '--cwd', home], run.ports);

  assert.equal(code, 0);
  const text = run.out.join('');
  assert.match(text, /generated\/demo-live/);
  assert.match(text, /\/demo-start/);
  assert.doesNotMatch(text, /model should not run/);
});

test('/self and /evolution-status render deterministic self-knowledge without a model turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-cli-ux-self-'));
  const script = await scriptFile(home, [{ kind: 'events', events: scriptedText('model should not run') }]);
  const lines: (string | null)[] = ['/self', '/evolution-status', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: home, nextLine: async () => lines[index++] ?? null });

  const code = await dispatch(['repl', '--script', script, '--cwd', home], run.ports);

  assert.equal(code, 0);
  const text = run.out.join('');
  assert.match(text, /Vegito self-map/);
  assert.match(text, /meta-harness/);
  assert.match(text, /Evolution status/);
  assert.match(text, /manual-triggered/);
  assert.doesNotMatch(text, /model should not run/);
});

test('packs prompt exposes stable discipline and dynamic self-map context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-cli-ux-prompt-'));
  const run = portsFor({ homeDir: home, cwd: home });

  const code = await dispatch(['packs', 'prompt', '--cwd', home], run.ports);

  assert.equal(code, 0);
  const text = run.out.join('');
  assert.match(text, /# System tier 1/);
  assert.match(text, /# System tier 2/);
  assert.match(text, /Tool discipline/);
  assert.match(text, /Claim discipline/);
  assert.match(text, /Harness mutations and evolution are manual by default/);
  assert.match(text, /## Self map/);
  assert.match(text, /manual-triggered/);
});

test('generated admissions counselor pack remains usable from the REPL', async () => {
  const repo = process.cwd();
  const home = await mkdtemp(join(tmpdir(), 'vegito-cli-ux-admissions-'));
  const script = await scriptFile(home, [{ kind: 'events', events: scriptedText('admissions profile reviewed') }]);
  const lines: (string | null)[] = ['/admissions-profile-review GPA 3.8 CS budget-sensitive early action', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: repo, nextLine: async () => lines[index++] ?? null });

  const code = await dispatch(['repl', '--pack', 'generated/admissions-counselor', '--script', script, '--cwd', repo], run.ports);

  assert.equal(code, 0);
  assert.match(run.out.join(''), /admissions profile reviewed/);
});
