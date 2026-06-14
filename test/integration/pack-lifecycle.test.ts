// P8 gate (IMPLEMENTATION_PLAN): a fixture pack contributing a tool, a skill,
// a hook, and a command loads, registers into the one registry, and executes
// through the real permission engine — and the malicious-manifest / hook-path
// corpus is rejected. This is the meta-harness substrate: if a pack can be
// installed safely and its pieces run under the single gate, forge (P11) has a
// trustworthy target to emit into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExtensionRegistry, loadPack } from '../../src/extend/index.ts';
import { createHookBus, spawnHookRunner } from '../../src/extend/hooks.ts';
import { defineTool } from '../../src/tools/spec.ts';
import { createEngine } from '../../src/permissions/engine.ts';
import { FileState } from '../../src/context/filestate.ts';

async function buildFixturePack(root: string): Promise<void> {
  // skill
  await mkdir(join(root, 'skills', 'band-score'), { recursive: true });
  await writeFile(
    join(root, 'skills', 'band-score', 'SKILL.md'),
    '---\nname: band-score\ndescription: Score an IELTS essay\n---\nApply the band descriptors...',
    'utf8',
  );
  // command
  await mkdir(join(root, 'commands'), { recursive: true });
  await writeFile(join(root, 'commands', 'mock-test.md'), '---\ndescription: Run a mock test\n---\nBegin mock: $ARGUMENTS', 'utf8');
  // hook (PreToolUse guard that blocks a tool named "delete")
  await mkdir(join(root, 'hooks'), { recursive: true });
  const guard = join(root, 'hooks', 'guard.sh');
  await writeFile(
    guard,
    '#!/usr/bin/env bash\nread -r line\nif echo "$line" | grep -q \'"tool":"delete"\'; then echo "delete blocked" >&2; exit 2; fi\necho "hook-ok"\nexit 0\n',
    'utf8',
  );
  await chmod(guard, 0o755);
  await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify([{ event: 'PreToolUse', command: './guard.sh' }]), 'utf8');
  // manifest
  await writeFile(
    join(root, 'pack.json'),
    JSON.stringify({
      schema: 1,
      name: 'ielts-tutor',
      version: '1.0.0',
      description: 'IELTS coaching pack',
      skills: './skills',
      commands: './commands',
      hooks: './hooks',
      grants: ['examiner:grade'],
    }),
    'utf8',
  );
}

test('P8 gate: a full fixture pack loads, registers, and runs through the gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vg-gate-pack-'));
  const ws = await mkdtemp(join(tmpdir(), 'vg-gate-ws-'));
  try {
    await buildFixturePack(root);
    const pack = await loadPack(root);
    const reg = createExtensionRegistry();
    await reg.installPack(pack, { trusted: true });

    // A pack-scoped tool registered under the namespaced surface.
    const gradeTool = defineTool({
      name: 'examiner:grade',
      description: 'Grade an essay against the rubric',
      schema: { type: 'object', properties: { essay: { type: 'string' } }, required: ['essay'], additionalProperties: false },
      exposure: 'direct',
      concurrencySafe: () => true,
      permissionKey: () => ({ tool: 'examiner:grade', action: 'read' }),
      run: async (input) => ({ content: `graded: ${(input as { essay: string }).essay}` }),
    });
    reg.tools.register(gradeTool);

    // 1. tool is on the surface
    assert.ok(reg.tools.list().some((t) => t.name === 'examiner:grade'));
    // 2. skill discovered
    assert.deepEqual(reg.skills().list().map((s) => s.name), ['band-score']);
    // 3. command discovered + skill-as-command bridge present
    const cmds = reg.commands().list().map((c) => c.name);
    assert.ok(cmds.includes('mock-test'));
    assert.ok(cmds.includes('band-score'));
    assert.equal(reg.commands().render('mock-test', 'writing task 2'), 'Begin mock: writing task 2');
    // 4. grant recorded (default-deny: recorded, not auto-allowed)
    assert.deepEqual([...reg.grants()], ['examiner:grade']);

    // 5. the tool executes through the REAL permission engine
    const engine = createEngine({
      workspace: ws,
      mode: 'default',
      rules: [{ tool: 'examiner:grade', action: 'read', verdict: 'allow' }],
    });
    const verdict = await engine.check(gradeTool.permissionKey({ essay: 'x' }));
    assert.equal(verdict, 'allow');
    const out = await gradeTool.run(
      { essay: 'My city has changed.' },
      { cwd: ws, signal: new AbortController().signal, files: new FileState() },
    );
    assert.equal(out.content, 'graded: My city has changed.');

    // 6. the pack hook fires through the real spawn runner: allows read, blocks delete
    const bus = createHookBus(reg.hookSpecs(), { runner: spawnHookRunner({ timeoutMs: 5000 }) });
    const allowed = await bus.dispatch('PreToolUse', { tool: 'examiner:grade' });
    assert.equal(allowed.decision, 'allow');
    assert.ok(allowed.contexts.some((c) => c.includes('hook-ok')));
    const blocked = await bus.dispatch('PreToolUse', { tool: 'delete' });
    assert.equal(blocked.decision, 'block');
    assert.ok(blocked.messages.some((m) => m.includes('delete blocked')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(ws, { recursive: true, force: true });
  }
});

test('P8 gate: malicious-manifest corpus is rejected at load', async () => {
  const corpus = [
    { schema: 1, name: 'a', version: '1.0.0', skills: '../../../etc' },
    { schema: 1, name: 'b', version: '1.0.0', hooks: '/absolute' },
    { schema: 1, name: 'c', version: '1.0.0', commands: './ok/../../escape' },
    { schema: 2, name: 'd', version: '1.0.0' }, // wrong schema
    { schema: 1, version: '1.0.0' }, // missing name
  ];
  for (const manifest of corpus) {
    const root = await mkdtemp(join(tmpdir(), 'vg-gate-evil-'));
    try {
      await writeFile(join(root, 'pack.json'), JSON.stringify(manifest), 'utf8');
      await assert.rejects(loadPack(root), `expected reject for ${JSON.stringify(manifest)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('P8 gate: a pack whose hooks.json escapes the root is rejected at install', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vg-gate-hookesc-'));
  try {
    await mkdir(join(root, 'hooks'), { recursive: true });
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify([{ event: 'Stop', command: '../../evil.sh' }]), 'utf8');
    await writeFile(
      join(root, 'pack.json'),
      JSON.stringify({ schema: 1, name: 'evil', version: '1.0.0', description: 'd', hooks: './hooks' }),
      'utf8',
    );
    const pack = await loadPack(root);
    const reg = createExtensionRegistry();
    await assert.rejects(reg.installPack(pack), /escape|outside|unsafe|path/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
