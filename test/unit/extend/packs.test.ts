// P8 packs (DESIGN §8): a pack is a directory with a pack.json manifest
// (schema:1, no legacy formats). Every path in the manifest must be
// "./"-prefixed, free of "..", and resolve inside the pack root — this is the
// security boundary that keeps a hostile pack from reaching arbitrary files.
// loadPack resolves the skill/command/hook directories and the pack-scoped
// default-deny tool grants.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseManifest, validatePackPath, loadPack } from '../../../src/extend/packs.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vg-pack-'));
}

const GOOD = JSON.stringify({
  schema: 1,
  name: 'ielts-tutor',
  version: '1.2.0',
  description: 'IELTS coaching',
  skills: './skills',
  commands: './commands',
  hooks: './hooks',
  evals: './evals/cases.json',
  grants: ['read', 'skill'],
});

test('parseManifest accepts a well-formed schema:1 manifest', () => {
  const m = parseManifest(GOOD);
  assert.equal(m.name, 'ielts-tutor');
  assert.equal(m.version, '1.2.0');
  assert.deepEqual(m.grants, ['read', 'skill']);
  assert.equal(m.evals, './evals/cases.json');
});

test('parseManifest rejects a non-1 schema (no legacy formats — A9)', () => {
  assert.throws(() => parseManifest(JSON.stringify({ schema: 2, name: 'x', version: '1.0.0' })), /schema/);
});

test('parseManifest rejects a missing name or version', () => {
  assert.throws(() => parseManifest(JSON.stringify({ schema: 1, version: '1.0.0' })), /name/);
  assert.throws(() => parseManifest(JSON.stringify({ schema: 1, name: 'x' })), /version/);
});

test('parseManifest rejects invalid JSON', () => {
  assert.throws(() => parseManifest('{not json'), /JSON|parse/i);
});

test('validatePackPath accepts a ./-prefixed in-root path', () => {
  assert.equal(validatePackPath('/packs/p', './skills'), true);
  assert.equal(validatePackPath('/packs/p', './a/b/c'), true);
});

test('validatePackPath rejects traversal, absolute, and bare paths', () => {
  for (const bad of ['../escape', './a/../../b', '/etc/passwd', 'skills', './..', '~/secrets']) {
    assert.equal(validatePackPath('/packs/p', bad), false, `should reject ${bad}`);
  }
});

test('loadPack resolves declared directories and grants', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'skills'), { recursive: true });
    await writeFile(join(root, 'pack.json'), GOOD, 'utf8');
    const pack = await loadPack(root);
    assert.equal(pack.manifest.name, 'ielts-tutor');
    assert.equal(pack.skillsDir, join(root, 'skills'));
    assert.equal(pack.commandsDir, join(root, 'commands'));
    assert.deepEqual(pack.manifest.grants, ['read', 'skill']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('loadPack rejects a manifest with a traversing path (adversarial corpus)', async () => {
  const corpus = [
    { skills: '../../etc' },
    { commands: '/absolute/path' },
    { hooks: './ok/../../../escape' },
    { persona: '..' },
    { evals: './evals/../../escape.json' },
  ];
  for (const overrides of corpus) {
    const root = await tmp();
    try {
      const manifest = { schema: 1, name: 'evil', version: '1.0.0', description: 'x', ...overrides };
      await writeFile(join(root, 'pack.json'), JSON.stringify(manifest), 'utf8');
      await assert.rejects(loadPack(root), /path|escape|traversal|outside/i, `expected reject for ${JSON.stringify(overrides)}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('loadPack rejects declared paths that are symlinks escaping the pack root', async () => {
  const root = await tmp();
  const outside = await tmp();
  try {
    await writeFile(join(outside, 'persona.md'), 'stolen persona', 'utf8');
    await symlink(join(outside, 'persona.md'), join(root, 'persona.md'));
    await writeFile(
      join(root, 'pack.json'),
      JSON.stringify({
        schema: 1,
        name: 'escape',
        version: '1.0.0',
        description: 'x',
        persona: './persona.md',
      }),
      'utf8',
    );

    await assert.rejects(loadPack(root), /escape|outside|unsafe|symlink|path/i);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('loadPack rejects when pack.json is absent', async () => {
  const root = await tmp();
  try {
    await assert.rejects(loadPack(root), /pack\.json|not found|ENOENT/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('parseManifest defaults grants to empty (pack-scoped default-deny)', () => {
  const m = parseManifest(JSON.stringify({ schema: 1, name: 'x', version: '1.0.0', description: 'd' }));
  assert.deepEqual(m.grants, []);
});
