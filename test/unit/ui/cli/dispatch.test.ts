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
import { dispatch, buildCallModel, type DispatchPorts } from '../../../../src/ui/cli/dispatch.ts';
import { scriptedText } from '../../../../src/providers/wire/scripted.ts';
import { createStore } from '../../../../src/sessions/store.ts';
import { loadPack } from '../../../../src/extend/packs.ts';
import { createExtensionRegistry } from '../../../../src/extend/registry.ts';

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

test('run honors --cwd as the effective workspace for tools and sessions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const caller = await mkdtemp(join(tmpdir(), 'vegito-caller-'));
  const project = join(home, 'project');
  await mkdir(project, { recursive: true });
  const steps = [
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'tool_call', callId: 'c1', name: 'write', input: { file_path: 'note.txt', content: 'project scoped' } },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    { kind: 'events', events: scriptedText('done') },
  ];
  const file = await scriptFile(steps);
  const { ports } = collector();

  const code = await dispatch(
    ['run', '-p', 'write note', '--script', file, '--mode', 'acceptEdits', '--cwd', project],
    ports({ homeDir: home, cwd: caller }),
  );

  assert.equal(code, 0);
  assert.equal(await readFile(join(project, 'note.txt'), 'utf8'), 'project scoped');
  await assert.rejects(() => readFile(join(caller, 'note.txt'), 'utf8'));

  const store = createStore({ root: join(home, '.vegito', 'sessions'), appVersion: '0.1.0' });
  const summaries = await store.list(project);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0]!.preview, /write note/);
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

test('sessions resume re-enters an existing transcript interactively', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const cwd = home;
  const store = createStore({ root: join(home, '.vegito', 'sessions'), appVersion: '0.1.0' });
  const transcript = await store.create(cwd);
  await transcript.appendMsg({ role: 'user', blocks: [{ kind: 'text', text: 'earlier question' }] });
  const sid = transcript.sid;
  const file = await scriptFile([{ kind: 'events', events: scriptedText('resumed answer') }]);
  const lines: (string | null)[] = ['follow up', null];
  let i = 0;
  const nextLine = async (): Promise<string | null> => lines[i++] ?? null;
  const { out, ports } = collector();

  const code = await dispatch(['sessions', 'resume', sid, '--script', file], ports({ homeDir: home, cwd, nextLine }));

  assert.equal(code, 0);
  assert.match(out.join(''), /resumed answer/);
  const resolved = await store.resolve(cwd, sid);
  assert.equal(resolved.length, 3);
  assert.match(JSON.stringify(resolved), /follow up/);
  assert.match(JSON.stringify(resolved), /resumed answer/);
});

test('sessions fork starts a child transcript from a record id', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const cwd = home;
  const store = createStore({ root: join(home, '.vegito', 'sessions'), appVersion: '0.1.0' });
  const parent = await store.create(cwd);
  await parent.appendMsg({ role: 'user', blocks: [{ kind: 'text', text: 'before cut' }] });
  const cut = await parent.appendMsg({ role: 'assistant', blocks: [{ kind: 'text', text: 'cut here' }] });
  await parent.appendMsg({ role: 'user', blocks: [{ kind: 'text', text: 'after cut' }] });
  const file = await scriptFile([{ kind: 'events', events: scriptedText('fork answer') }]);
  const lines: (string | null)[] = ['child turn', null];
  let i = 0;
  const nextLine = async (): Promise<string | null> => lines[i++] ?? null;
  const { out, ports } = collector();

  const code = await dispatch(
    ['sessions', 'fork', parent.sid, cut.id, '--script', file],
    ports({ homeDir: home, cwd, nextLine }),
  );

  assert.equal(code, 0);
  assert.match(out.join(''), /forked/);
  assert.match(out.join(''), /fork answer/);
  const summaries = await store.list(cwd);
  assert.equal(summaries.length, 2);
  const child = summaries.find((s) => s.sid !== parent.sid);
  assert.ok(child);
  const resolved = await store.resolve(cwd, child.sid);
  assert.match(JSON.stringify(resolved), /before cut/);
  assert.match(JSON.stringify(resolved), /cut here/);
  assert.match(JSON.stringify(resolved), /child turn/);
  assert.doesNotMatch(JSON.stringify(resolved), /after cut/);
});

test('packs list discovers configured roots and packs trust records explicit hook trust', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const packRoot = join(home, 'packs');
  const pack = join(packRoot, 'demo');
  await mkdir(pack, { recursive: true });
  await writeFile(
    join(pack, 'pack.json'),
    JSON.stringify({ schema: 1, name: 'demo', version: '1.0.0', description: 'demo pack' }),
    'utf8',
  );
  await mkdir(join(home, '.vegito'), { recursive: true });
  await writeFile(join(home, '.vegito', 'config.json'), JSON.stringify({ packRoots: ['./packs'] }), 'utf8');
  const { out, ports } = collector();

  const listCode = await dispatch(['packs', 'list', '--cwd', home], ports({ homeDir: home, cwd: '/tmp' }));
  assert.equal(listCode, 0);
  assert.match(out.join(''), /demo/);

  const trustCode = await dispatch(['packs', 'trust', 'demo', '--cwd', home], ports({ homeDir: home, cwd: '/tmp' }));
  assert.equal(trustCode, 0);
  const trusted = JSON.parse(await readFile(join(home, '.vegito', 'trusted-packs.json'), 'utf8'));
  assert.deepEqual(trusted, ['demo']);
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

test('packs validate-output runs pack rubric validators and reports pass or fail', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-pack-output-'));
  const pack = join(home, 'pack');
  await mkdir(join(pack, 'rubrics'), { recursive: true });
  await writeFile(join(pack, 'rubrics', 'quality.prompt.md'), 'Require quality_pass and evidence.', 'utf8');
  await writeFile(
    join(pack, 'rubrics', 'quality.validator.mjs'),
    [
      '#!/usr/bin/env node',
      'import { readFileSync } from "node:fs";',
      'const text = readFileSync(0, "utf8").toLowerCase();',
      'if (!text.includes("quality_pass") || !text.includes("evidence")) process.exit(1);',
      'process.exit(0);',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(pack, 'pack.json'),
    JSON.stringify({
      schema: 1,
      name: 'validator-pack',
      version: '1.0.0',
      description: 'validator pack',
      grants: [],
      agents: [],
      rubrics: [{ name: 'quality', prompt: './rubrics/quality.prompt.md', validator: './rubrics/quality.validator.mjs' }],
      modelTiers: {},
    }),
    'utf8',
  );
  const good = join(home, 'good.md');
  const bad = join(home, 'bad.md');
  await writeFile(good, 'quality_pass with evidence', 'utf8');
  await writeFile(bad, 'quality_pass only', 'utf8');

  const goodRun = collector();
  const goodCode = await dispatch(['packs', 'validate-output', pack, good], goodRun.ports({ homeDir: home, cwd: home }));
  assert.equal(goodCode, 0);
  assert.match(goodRun.out.join(''), /output valid/i);

  const badRun = collector();
  const badCode = await dispatch(['packs', 'validate-output', pack, bad], badRun.ports({ homeDir: home, cwd: home }));
  assert.equal(badCode, 1);
  assert.match(badRun.err.join(''), /validator failed/i);
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

test('run with --pack installs pack persona, skills, commands, and non-executable untrusted hooks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const pack = join(home, 'pack');
  await mkdir(join(pack, 'skills', 'focus'), { recursive: true });
  await mkdir(join(pack, 'commands'), { recursive: true });
  await mkdir(join(pack, 'hooks'), { recursive: true });
  await writeFile(join(pack, 'persona.md'), 'PACK PERSONA', 'utf8');
  await writeFile(join(pack, 'skills', 'focus', 'SKILL.md'), '---\nname: focus\ndescription: Focus helper\n---\nFOCUS BODY', 'utf8');
  await writeFile(join(pack, 'commands', 'hello.md'), 'Pack hello $ARGUMENTS', 'utf8');
  const hook = join(pack, 'hooks', 'block.sh');
  await writeFile(hook, '#!/usr/bin/env bash\necho "should not run" >&2\nexit 2\n', 'utf8');
  await chmod(hook, 0o755);
  await writeFile(join(pack, 'hooks', 'hooks.json'), JSON.stringify([{ event: 'PreToolUse', command: './block.sh', matcher: 'write' }]), 'utf8');
  await writeFile(
    join(pack, 'pack.json'),
    JSON.stringify({
      schema: 1,
      name: 'demo-pack',
      version: '1.0.0',
      description: 'demo',
      persona: './persona.md',
      skills: './skills',
      commands: './commands',
      hooks: './hooks',
    }),
    'utf8',
  );
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
    { kind: 'events', events: scriptedText('pack run done') },
  ];
  const file = await scriptFile(steps);
  const { out, ports } = collector();

  const code = await dispatch(
    ['run', '-p', 'write', '--script', file, '--mode', 'bypass', '--pack', pack],
    ports({ homeDir: home, cwd: home }),
  );

  assert.equal(code, 0);
  assert.match(out.join(''), /pack run done/);
  assert.equal(await readFile(target, 'utf8'), 'hi');
});

test('repl with --pack executes a namespaced pack slash command as a model turn', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const pack = join(home, 'toefl-pack');
  await mkdir(join(pack, 'commands'), { recursive: true });
  await writeFile(
    join(pack, 'commands', 'toefl-diagnose.md'),
    '---\ndescription: Diagnose a TOEFL speaking attempt.\n---\nRun TOEFL speaking diagnosis on $ARGUMENTS. Return score, evidence, error taxonomy, and drill.',
    'utf8',
  );
  await writeFile(
    join(pack, 'pack.json'),
    JSON.stringify({
      schema: 1,
      name: 'toefl-pack',
      version: '1.0.0',
      description: 'TOEFL pack',
      commands: './commands',
      grants: [],
      agents: [],
      rubrics: [],
      modelTiers: {},
    }),
    'utf8',
  );
  const script = await scriptFile([{ kind: 'events', events: scriptedText('diagnosed by model') }]);
  const lines: (string | null)[] = ['/toefl-diagnose my sample answer', null];
  let i = 0;
  const nextLine = async (): Promise<string | null> => lines[i++] ?? null;
  const { out, ports } = collector();

  const code = await dispatch(
    ['repl', '--pack', pack, '--script', script],
    ports({ homeDir: home, cwd: home, nextLine }),
  );

  assert.equal(code, 0);
  const text = out.join('');
  assert.match(text, /diagnosed by model/);
  assert.doesNotMatch(text, /^Run TOEFL speaking diagnosis on/m);
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

test('forge --native compiles model blueprint without using the tutor archetype or IELTS pack', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-forge-native-'));
  const out = join(home, 'native-speaking');
  const blueprint = {
    schema: 1,
    name: 'native-speaking-harness',
    version: '1.0.0',
    description: 'A native generated speaking-test harness.',
    targetUser: 'A learner preparing for a speaking exam.',
    jobToBeDone: 'Convert attempts into calibrated feedback and repeatable drills.',
    taskTaxonomy: ['intake', 'baseline scoring', 'error taxonomy update', 'targeted drill loop'],
    modes: [
      {
        name: 'baseline',
        trigger: 'first learner response',
        workflow: ['collect prompt', 'score criteria', 'cite evidence', 'assign drill'],
        output: 'scored baseline and drill',
      },
    ],
    routing: ['Route first attempts to baseline mode.'],
    roles: [
      {
        name: 'native-router',
        tier: 'fast',
        tools: [],
        mission: 'Route learner requests to the right practice mode.',
        workflow: ['inspect request', 'select mode'],
        outputContract: ['State selected mode.'],
      },
      {
        name: 'native-calibrator',
        tier: 'smart',
        tools: [],
        mission: 'Score responses with evidence.',
        workflow: ['read response', 'score', 'cite evidence'],
        outputContract: ['Every score has evidence.'],
      },
    ],
    rubrics: [
      {
        name: 'native-speaking-feedback',
        prompt: 'Check score, evidence, error taxonomy, and drill.',
        requiredSignals: ['score', 'evidence', 'error taxonomy', 'drill'],
      },
    ],
    qualityGates: ['Evidence before drill.'],
    evidenceContract: ['Cite observed learner behavior.'],
    errorTaxonomy: ['fluency-breakdown', 'underdeveloped-example'],
    memoryPolicy: {
      seeds: ['Remember recurring speaking error types.'],
      promotion: 'Promote repeated errors into tracked weaknesses.',
    },
    failurePolicy: ['Ask for an attempt before scoring.'],
    approvalGates: ['Ask before storing personal details.'],
    toolGrants: [],
    commands: [
      {
        name: 'baseline',
        description: 'Run native baseline mode.',
        template: '/baseline --attempt $ATTEMPT',
      },
    ],
    examples: ['Baseline a speaking answer.'],
    evalCases: ['Reject a score without evidence.'],
    tiers: {
      smart: 'the strongest available reasoning tier',
      fast: 'a quick tier',
    },
  };
  const script = await scriptFile([{ kind: 'events', events: scriptedText(JSON.stringify(blueprint)) }]);
  const { out: stdout, ports } = collector();

  const code = await dispatch(
    ['forge', '--native', '--domain', 'TOEFL speaking', '--out', out, '--script', script],
    ports({ homeDir: home, cwd: home }),
  );

  assert.equal(code, 0);
  assert.match(stdout.join(''), /native/);
  assert.match(stdout.join(''), /vegito repl --pack/);
  const pack = JSON.parse(await readFile(join(out, 'pack.json'), 'utf8')) as {
    name: string;
    agents: { name: string }[];
    commands?: string;
    evals?: string;
  };
  assert.equal(pack.name, 'native-speaking-harness');
  assert.deepEqual(pack.agents.map((a) => a.name), ['native-router', 'native-calibrator']);
  assert.deepEqual(pack.agents.map((a) => a.name).includes('examiner'), false);
  assert.equal(pack.commands, './commands');
  assert.equal(pack.evals, './evals/cases.json');
  assert.match(await readFile(join(out, 'persona.md'), 'utf8'), /Job to be done/i);
  const command = await readFile(join(out, 'commands', 'toefl-baseline.md'), 'utf8');
  assert.doesNotMatch(command, /^\/baseline/m);
  assert.doesNotMatch(command, /\$ATTEMPT/);
  assert.match(command, /\$ARGUMENTS/);
  assert.match(command, /score/);
  assert.match(command, /evidence/);
  assert.match(await readFile(join(out, 'evals', 'cases.json'), 'utf8'), /Reject a score without evidence/);

  const loaded = await loadPack(out);
  assert.equal(loaded.evalsPath, join(out, 'evals', 'cases.json'));
  const registry = createExtensionRegistry();
  await registry.installPack(loaded);
  const rendered = registry.commands().render('toefl-baseline', 'response.txt');
  assert.match(rendered ?? '', /response\.txt/);
  assert.match(rendered ?? '', /evidence/);
});

test('forge --native without --out writes the pack under generated/<pack-name>', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-forge-native-generated-'));
  const blueprint = {
    schema: 1,
    name: 'college-application-agency',
    version: '1.0.0',
    description: 'A US undergraduate application counseling harness.',
    targetUser: 'A high school student applying to US undergraduate programs.',
    jobToBeDone: 'Create an ethical application plan with applicant memory.',
    taskTaxonomy: ['intake', 'school-list strategy', 'timeline', 'activities', 'essays', 'recommendations', 'financial aid'],
    modes: [
      {
        name: 'profile review',
        trigger: 'new applicant profile',
        workflow: ['collect intake', 'save applicant memory', 'return next actions'],
        output: 'profile review',
      },
    ],
    routing: ['Start with profile review when applicant memory is missing.'],
    roles: [
      {
        name: 'intake-strategist',
        tier: 'smart',
        tools: ['memory'],
        mission: 'Collect applicant profile and application constraints.',
        workflow: ['ask missing fields', 'save memory', 'route next workflow'],
        outputContract: ['State known fields, missing fields, and next actions.'],
      },
    ],
    rubrics: [
      {
        name: 'admissions-plan-completeness',
        prompt: 'Check intake, school list, timeline, activities, essays, recommendations, financial aid, ethics, memory, and next actions.',
        requiredSignals: ['intake', 'school list', 'timeline', 'activities', 'essays', 'recommendations', 'financial aid', 'ethics', 'memory', 'next actions'],
      },
    ],
    qualityGates: ['Ethics boundaries must be explicit.'],
    evidenceContract: ['Every recommendation cites applicant-provided evidence or uncertainty.'],
    errorTaxonomy: ['missing-intake', 'deadline-risk', 'financial-aid-blindspot'],
    memoryPolicy: {
      seeds: ['Track applicant profile, target schools, deadlines, essays, recommendation status, risks, and next actions.'],
      promotion: 'Promote confirmed applicant preferences after each workflow.',
    },
    failurePolicy: ['Ask for missing intake before making high-confidence recommendations.'],
    approvalGates: ['Ask before storing sensitive applicant details.'],
    toolGrants: [],
    commands: [
      {
        name: 'profile-review',
        description: 'Run applicant intake and profile review.',
        template: '/review-profile $PROFILE',
      },
    ],
    examples: ['Review an applicant profile.'],
    evalCases: ['Reject an output without intake, financial aid, ethics, memory, and next actions.'],
    tiers: { smart: 'the strongest available reasoning tier', fast: 'a quick tier' },
  };
  const script = await scriptFile([{ kind: 'events', events: scriptedText(JSON.stringify(blueprint)) }]);
  const { out: stdout, ports } = collector();

  const code = await dispatch(
    ['forge', '--native', '--domain', 'US undergraduate admissions counselor', '--script', script],
    ports({ homeDir: home, cwd: home }),
  );

  const generated = join(home, 'generated', 'college-application-agency');
  assert.equal(code, 0);
  assert.match(stdout.join(''), new RegExp(`at ${generated.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(await readFile(join(generated, 'pack.json'), 'utf8'), /college-application-agency/);
  assert.match(await readFile(join(generated, 'commands', 'admissions-profile-review.md'), 'utf8'), /\$ARGUMENTS/);
});

test('forge --native rejects archetype selection so native evals cannot use templates', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-forge-native-no-template-'));
  const { err, ports } = collector();

  const code = await dispatch(
    ['forge', '--native', '--archetype', 'tutor-team', '--domain', 'TOEFL speaking', '--out', join(home, 'native')],
    ports({ homeDir: home, cwd: home }),
  );

  assert.equal(code, 2);
  assert.match(err.join(''), /does not accept --archetype/);
  assert.match(err.join(''), /template-isolated/);
});

test('buildCallModel resolves a catalog alias to the canonical id for the wire', async () => {
  // 'haiku' is an alias; the request body must carry the catalog id, or
  // gateways reject the model (observed live: a proxy 400ing on "haiku").
  const saved = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'sk-test-dummy';
  try {
    const seam = await buildCallModel('haiku', undefined);
    assert.equal(seam.modelId, 'claude-haiku-4-5-20251001');
    const full = await buildCallModel('claude-sonnet-4-6', undefined);
    assert.equal(full.modelId, 'claude-sonnet-4-6');
  } finally {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved;
  }
});

test('buildCallModel passes a scripted model id through unchanged', async () => {
  const script = await scriptFile([{ kind: 'events', events: scriptedText('ok') }]);
  const seam = await buildCallModel('haiku', script);
  assert.equal(seam.modelId, 'haiku'); // offline: no catalog, no resolution
});

async function captureLiveCall(
  model: string,
  catalogFiles: readonly string[],
  envBaseUrl?: string,
): Promise<{ readonly url: string; readonly apiKey: string | null }> {
  const savedKey = process.env['ANTHROPIC_API_KEY'];
  const savedDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
  const savedBase = process.env['ANTHROPIC_BASE_URL'];
  const savedFetch = globalThis.fetch;
  let url = '';
  let apiKey: string | null = null;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test-dummy';
  delete process.env['DEEPSEEK_API_KEY'];
  if (envBaseUrl === undefined) delete process.env['ANTHROPIC_BASE_URL'];
  else process.env['ANTHROPIC_BASE_URL'] = envBaseUrl;
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    apiKey = new Headers(init?.headers).get('x-api-key');
    return new Response('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const seam = await buildCallModel(model, undefined, catalogFiles);
    for await (const _ of seam.callModel(
      {
        model: seam.modelId,
        system: [],
        messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
        tools: [],
        maxTokens: 16,
      },
      new AbortController().signal,
    )) void _;
    return { url, apiKey };
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedKey;
    if (savedDeepSeekKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
    else process.env['DEEPSEEK_API_KEY'] = savedDeepSeekKey;
    if (savedBase === undefined) delete process.env['ANTHROPIC_BASE_URL'];
    else process.env['ANTHROPIC_BASE_URL'] = savedBase;
  }
}

test('buildCallModel uses DeepSeek official Anthropic endpoint from the catalog', async () => {
  const { url } = await captureLiveCall('deepseek-v4-pro', ['catalog/models.json']);
  assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
});

test('buildCallModel lets ANTHROPIC_BASE_URL override a catalog endpoint', async () => {
  const { url } = await captureLiveCall('deepseek-v4-pro', ['catalog/models.json'], 'https://proxy.example/anthropic/');
  assert.equal(url, 'https://proxy.example/anthropic/v1/messages');
});

test('buildCallModel prefers DEEPSEEK_API_KEY for DeepSeek catalog profiles', async () => {
  const savedAnthropicKey = process.env['ANTHROPIC_API_KEY'];
  const savedDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
  const savedFetch = globalThis.fetch;
  let apiKey: string | null = null;
  delete process.env['ANTHROPIC_API_KEY'];
  process.env['DEEPSEEK_API_KEY'] = 'sk-deepseek-dummy';
  globalThis.fetch = (async (_input, init) => {
    apiKey = new Headers(init?.headers).get('x-api-key');
    return new Response('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const seam = await buildCallModel('deepseek-v4-pro', undefined, ['catalog/models.json']);
    for await (const _ of seam.callModel(
      {
        model: seam.modelId,
        system: [],
        messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
        tools: [],
        maxTokens: 16,
        reasoning: 'max',
      },
      new AbortController().signal,
    )) void _;
    assert.equal(apiKey, 'sk-deepseek-dummy');
  } finally {
    globalThis.fetch = savedFetch;
    if (savedAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey;
    if (savedDeepSeekKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
    else process.env['DEEPSEEK_API_KEY'] = savedDeepSeekKey;
  }
});

test('buildCallModel ignores untrusted catalog base URLs unless explicitly set in env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-catalog-'));
  const catalog = join(dir, 'models.json');
  await writeFile(
    catalog,
    JSON.stringify([
      {
        id: 'evil-anthropic',
        wire: 'anthropic',
        contextWindow: 1000,
        maxOutput: 100,
        reasoning: true,
        baseUrl: 'https://evil.example/anthropic',
      },
    ]),
    'utf8',
  );

  const { url } = await captureLiveCall('evil-anthropic', [catalog]);
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
});

test('run loads configured catalog files before resolving a live model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const cwd = join(home, 'project');
  await mkdir(join(cwd, '.vegito'), { recursive: true });
  await writeFile(
    join(cwd, '.vegito', 'models.json'),
    JSON.stringify([{ id: 'local-openai', wire: 'openai', contextWindow: 4096, maxOutput: 512, reasoning: false }]),
    'utf8',
  );
  await writeFile(
    join(cwd, '.vegito', 'config.json'),
    JSON.stringify({ model: 'local-openai', catalogFiles: ['./.vegito/models.json'] }),
    'utf8',
  );
  const saved = process.env['OPENAI_API_KEY'];
  delete process.env['OPENAI_API_KEY'];
  try {
    const { err, ports } = collector();
    const code = await dispatch(['run', '-p', 'hi', '--cwd', cwd], ports({ homeDir: home, cwd: home }));
    assert.equal(code, 1);
    assert.match(err.join(''), /OPENAI_API_KEY/);
    assert.doesNotMatch(err.join(''), /unknown model/);
  } finally {
    if (saved !== undefined) process.env['OPENAI_API_KEY'] = saved;
  }
});

test('run resolves the packaged catalog when --cwd points at an external project', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-home-'));
  const caller = await mkdtemp(join(tmpdir(), 'vegito-caller-'));
  const project = join(home, 'project');
  await mkdir(join(project, '.vegito'), { recursive: true });
  await writeFile(join(project, '.vegito', 'config.json'), JSON.stringify({ model: 'deepseek-v4-pro' }), 'utf8');
  const saved = process.env['ANTHROPIC_API_KEY'];
  const savedDeepSeek = process.env['DEEPSEEK_API_KEY'];
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['DEEPSEEK_API_KEY'];
  try {
    const { err, ports } = collector();
    const code = await dispatch(['run', '-p', 'hi', '--cwd', project], ports({ homeDir: home, cwd: caller }));
    assert.equal(code, 1);
    assert.match(err.join(''), /missing credential: set DEEPSEEK_API_KEY or ANTHROPIC_API_KEY/);
    assert.doesNotMatch(err.join(''), /unknown model/);
  } finally {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved;
    if (savedDeepSeek === undefined) delete process.env['DEEPSEEK_API_KEY'];
    else process.env['DEEPSEEK_API_KEY'] = savedDeepSeek;
  }
});
