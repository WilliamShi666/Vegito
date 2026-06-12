// P11.1 pack anatomy + deep validation (DESIGN §8/§10). The P8 manifest carried
// only persona/skills/commands/hooks; forge needs the full anatomy — tiered
// agents, rubric↔validator pairs, memory seeds, onboarding, model tiers — still
// under schema:1 (A9, no legacy). Beyond path safety, `packs validate` enforces
// two small-harness lessons: every rubric pairs a soft prompt with a hard
// validator, and no single prompt carries more than 5 negative constraints.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseManifest } from '../../../src/extend/packs.ts';
import {
  countNegativeConstraints,
  validateManifestSemantics,
  validatePack,
  MAX_NEGATIVE_CONSTRAINTS,
} from '../../../src/extend/pack-validate.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vg-anatomy-'));
}

const FULL = {
  schema: 1,
  name: 'ielts-tutor',
  version: '1.0.0',
  description: 'IELTS coaching team',
  persona: './soul.md',
  agents: [
    { name: 'examiner', model: 'tier:smart', tools: ['read', 'skill'], prompt: './agents/examiner.md' },
    { name: 'coach', model: 'tier:worker', tools: ['read'], prompt: './agents/coach.md' },
  ],
  skills: './skills',
  commands: './commands',
  rubrics: [{ name: 'writing-band', prompt: './rubrics/writing.md', validator: './validators/writing.sh' }],
  memory: { seeds: './memory-seeds', promotion: 'l1l2l3' },
  onboarding: './onboarding.md',
  modelTiers: { smart: 'best-available', worker: 'cheap-available' },
  grants: ['read', 'skill'],
};

test('parseManifest carries the full anatomy (agents, rubrics, memory, tiers)', () => {
  const m = parseManifest(JSON.stringify(FULL));
  assert.equal(m.agents.length, 2);
  assert.equal(m.agents[0]?.name, 'examiner');
  assert.deepEqual(m.agents[0]?.tools, ['read', 'skill']);
  assert.equal(m.rubrics.length, 1);
  assert.equal(m.rubrics[0]?.validator, './validators/writing.sh');
  assert.equal(m.onboarding, './onboarding.md');
  assert.equal(m.memory?.seeds, './memory-seeds');
  assert.equal(m.modelTiers['smart'], 'best-available');
});

test('parseManifest defaults the new collections to empty (backward compatible)', () => {
  const m = parseManifest(JSON.stringify({ schema: 1, name: 'x', version: '1.0.0', description: 'd' }));
  assert.deepEqual(m.agents, []);
  assert.deepEqual(m.rubrics, []);
  assert.deepEqual(m.modelTiers, {});
});

test('countNegativeConstraints counts prohibition lines, not prose', () => {
  const text = [
    'You are a careful examiner.',
    "- Don't reveal the answer key.",
    '- Never fabricate a band score.',
    '- Avoid leading questions.',
    'Always cite the rubric.',
    'Do not exceed the time limit.',
  ].join('\n');
  assert.equal(countNegativeConstraints(text), 4);
});

test('validateManifestSemantics flags an unpaired rubric', () => {
  const bad = parseManifest(
    JSON.stringify({ ...FULL, rubrics: [{ name: 'r', prompt: './rubrics/r.md' }] }),
  );
  const problems = validateManifestSemantics(bad);
  assert.ok(problems.some((p) => /validator/i.test(p)), problems.join('; '));
});

test('validateManifestSemantics flags an agent on an undefined tier', () => {
  const bad = parseManifest(
    JSON.stringify({
      ...FULL,
      agents: [{ name: 'x', model: 'tier:nonexistent', tools: [], prompt: './agents/x.md' }],
    }),
  );
  const problems = validateManifestSemantics(bad);
  assert.ok(problems.some((p) => /tier|nonexistent/i.test(p)), problems.join('; '));
});

test('validateManifestSemantics passes a well-formed full manifest', () => {
  assert.deepEqual(validateManifestSemantics(parseManifest(JSON.stringify(FULL))), []);
});

test('validatePack rejects a prompt that exceeds the negative-constraint budget', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'agents'), { recursive: true });
    const tooMany = [
      'You are an over-constrained agent.',
      ...Array.from({ length: MAX_NEGATIVE_CONSTRAINTS + 1 }, (_, i) => `- Never do bad thing ${i}.`),
    ].join('\n');
    await writeFile(join(root, 'soul.md'), 'persona', 'utf8');
    await writeFile(join(root, 'agents', 'examiner.md'), tooMany, 'utf8');
    await writeFile(join(root, 'agents', 'coach.md'), 'be kind', 'utf8');
    await mkdir(join(root, 'rubrics'), { recursive: true });
    await mkdir(join(root, 'validators'), { recursive: true });
    await writeFile(join(root, 'rubrics', 'writing.md'), 'band descriptors', 'utf8');
    await writeFile(join(root, 'validators', 'writing.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    await writeFile(join(root, 'onboarding.md'), 'welcome', 'utf8');
    await writeFile(join(root, 'pack.json'), JSON.stringify(FULL), 'utf8');

    const result = await validatePack(root);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => /constraint|examiner/i.test(p)), result.problems.join('; '));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validatePack accepts a well-formed pack within budget', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'agents'), { recursive: true });
    await mkdir(join(root, 'rubrics'), { recursive: true });
    await mkdir(join(root, 'validators'), { recursive: true });
    await writeFile(join(root, 'soul.md'), 'persona', 'utf8');
    await writeFile(join(root, 'agents', 'examiner.md'), "You are an examiner.\n- Don't leak answers.", 'utf8');
    await writeFile(join(root, 'agents', 'coach.md'), 'You are a coach.', 'utf8');
    await writeFile(join(root, 'rubrics', 'writing.md'), 'band descriptors', 'utf8');
    await writeFile(join(root, 'validators', 'writing.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
    await writeFile(join(root, 'onboarding.md'), 'welcome', 'utf8');
    await writeFile(join(root, 'pack.json'), JSON.stringify(FULL), 'utf8');

    const result = await validatePack(root);
    assert.equal(result.ok, true, result.problems.join('; '));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
