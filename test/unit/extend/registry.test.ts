// P8 registry: the one namespaced registry (DESIGN §8). It composes the tool
// registry, skill/command discovery roots, and the hook table, and knows how
// to install a pack — folding the pack's skills, commands, hooks, and grants
// into the unified surface. Everything a pack contributes still runs through
// the same permission gate; grants are recorded, not auto-allowed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createExtensionRegistry } from '../../../src/extend/registry.ts';
import { loadPack } from '../../../src/extend/packs.ts';
import { defineTool } from '../../../src/tools/spec.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vg-reg-'));
}

const noop = defineTool({
  name: 'noop',
  description: 'does nothing',
  schema: { type: 'object' },
  exposure: 'direct',
  concurrencySafe: () => true,
  permissionKey: () => ({ tool: 'noop', action: 'read' }),
  run: async () => ({ content: 'ok' }),
});

test('a fresh registry is empty but functional', () => {
  const reg = createExtensionRegistry();
  assert.deepEqual(reg.skills().list(), []);
  assert.deepEqual(reg.commands().list(), []);
  assert.deepEqual(reg.tools.list(), []);
  assert.deepEqual([...reg.grants()], []);
});

test('addSkillRoot/addCommandRoot feed discovery; skills also surface as commands', async () => {
  const root = await tmp();
  try {
    const sdir = join(root, 'skills', 'plan');
    await mkdir(sdir, { recursive: true });
    await writeFile(join(sdir, 'SKILL.md'), '---\nname: plan\ndescription: planning\n---\nPLAN', 'utf8');
    const cdir = join(root, 'commands');
    await mkdir(cdir, { recursive: true });
    await writeFile(join(cdir, 'greet.md'), 'Hello $ARGUMENTS', 'utf8');

    const reg = createExtensionRegistry();
    reg.addSkillRoot(join(root, 'skills'));
    reg.addCommandRoot(cdir);

    assert.deepEqual(
      reg.skills().list().map((s) => s.name),
      ['plan'],
    );
    const cmdNames = reg.commands().list().map((c) => c.name);
    assert.ok(cmdNames.includes('greet'));
    assert.ok(cmdNames.includes('plan')); // skill-as-command bridge
    assert.equal(reg.commands().render('greet', 'world'), 'Hello world');
    assert.equal(reg.commands().render('plan', 'x'), 'PLAN');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('registering a tool exposes it; duplicate name throws', () => {
  const reg = createExtensionRegistry();
  reg.tools.register(noop);
  assert.deepEqual(reg.tools.list().map((t) => t.name), ['noop']);
  assert.throws(() => reg.tools.register(noop), /already registered/);
});

test('installPack folds skills, commands, hooks, and grants into the registry', async () => {
  const root = await tmp();
  try {
    // pack with skill + command + hook + grants
    await mkdir(join(root, 'skills', 'examine'), { recursive: true });
    await writeFile(
      join(root, 'skills', 'examine', 'SKILL.md'),
      '---\nname: examine\ndescription: examiner skill\n---\nEXAMINE BODY',
      'utf8',
    );
    await mkdir(join(root, 'commands'), { recursive: true });
    await writeFile(join(root, 'commands', 'score.md'), 'Score: $ARGUMENTS', 'utf8');
    await mkdir(join(root, 'hooks'), { recursive: true });
    const hookScript = join(root, 'hooks', 'pre.sh');
    await writeFile(hookScript, '#!/usr/bin/env bash\necho ctx\nexit 0\n', 'utf8');
    await chmod(hookScript, 0o755);
    await writeFile(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify([{ event: 'PreToolUse', command: './pre.sh' }]),
      'utf8',
    );
    await writeFile(
      join(root, 'pack.json'),
      JSON.stringify({
        schema: 1,
        name: 'ielts',
        version: '1.0.0',
        description: 'd',
        skills: './skills',
        commands: './commands',
        hooks: './hooks',
        grants: ['read', 'skill'],
      }),
      'utf8',
    );

    const pack = await loadPack(root);
    const reg = createExtensionRegistry();
    await reg.installPack(pack, { trusted: true });

    assert.deepEqual(reg.skills().list().map((s) => s.name), ['examine']);
    const cmds = reg.commands().list().map((c) => c.name);
    assert.ok(cmds.includes('score'));
    assert.ok(cmds.includes('examine'));
    assert.deepEqual([...reg.grants()].sort(), ['read', 'skill']);
    assert.equal(reg.hookSpecs().length, 1);
    assert.equal(reg.hookSpecs()[0]?.event, 'PreToolUse');
    assert.equal(reg.hookSpecs()[0]?.command, hookScript); // resolved to absolute, inside pack
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installPack skips executable hooks from untrusted packs', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'hooks'), { recursive: true });
    const hookScript = join(root, 'hooks', 'pre.sh');
    await writeFile(hookScript, '#!/usr/bin/env bash\necho ctx\nexit 0\n', 'utf8');
    await chmod(hookScript, 0o755);
    await writeFile(join(root, 'hooks', 'hooks.json'), JSON.stringify([{ event: 'PreToolUse', command: './pre.sh' }]), 'utf8');
    await writeFile(
      join(root, 'pack.json'),
      JSON.stringify({ schema: 1, name: 'untrusted', version: '1.0.0', description: 'd', hooks: './hooks' }),
      'utf8',
    );

    const pack = await loadPack(root);
    const reg = createExtensionRegistry();
    await reg.installPack(pack);
    assert.deepEqual(reg.hookSpecs(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('installPack rejects a hooks.json command that escapes the pack root', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'hooks'), { recursive: true });
    await writeFile(
      join(root, 'hooks', 'hooks.json'),
      JSON.stringify([{ event: 'Stop', command: '../../../bin/evil' }]),
      'utf8',
    );
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
