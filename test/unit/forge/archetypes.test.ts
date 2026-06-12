import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slug } from '../../../src/forge/spec.ts';
import { ARCHETYPES, ARCHETYPE_IDS, getArchetype } from '../../../src/forge/templates/index.ts';
import { countNegativeConstraints, MAX_NEGATIVE_CONSTRAINTS } from '../../../src/extend/pack-validate.ts';

test('slug lower-kebabs free text and survives junk', () => {
  assert.equal(slug('IELTS Writing'), 'ielts-writing');
  assert.equal(slug('  Go (services)!! '), 'go-services');
  assert.equal(slug('***'), 'pack');
});

test('every archetype id resolves to a builder; unknown throws', () => {
  assert.deepEqual([...ARCHETYPE_IDS].sort(), ['content-studio', 'review-team', 'tutor-team']);
  for (const id of ARCHETYPE_IDS) assert.equal(typeof getArchetype(id), 'function');
  assert.throws(() => getArchetype('nope'), /unknown archetype/);
});

test('archetypes are pure: same params produce a deep-equal spec', () => {
  for (const id of ARCHETYPE_IDS) {
    const build = getArchetype(id);
    assert.deepEqual(build({ domain: 'X' }), build({ domain: 'X' }));
  }
});

test('tutor-team yields three tiered agents, a paired rubric, and memory', () => {
  const spec = ARCHETYPES['tutor-team']!({ domain: 'IELTS writing' });
  assert.equal(spec.name, 'ielts-writing-tutor');
  assert.deepEqual(spec.agents.map((a) => a.name), ['examiner', 'coach', 'drill-master']);
  // every agent tier is declared in spec.tiers (no dangling tier — validatePack rule).
  for (const a of spec.agents) assert.ok(a.tier in spec.tiers, `tier ${a.tier} declared`);
  assert.equal(spec.rubrics.length, 1);
  assert.ok(spec.rubrics[0]!.prompt.length > 0);
  assert.ok(spec.rubrics[0]!.validator.includes('process.exit'));
  assert.ok((spec.memory?.seeds?.length ?? 0) >= 1);
});

test('archetype params override name and description', () => {
  const spec = getArchetype('review-team')({ domain: 'Go services', name: 'custom-id', description: 'desc' });
  assert.equal(spec.name, 'custom-id');
  assert.equal(spec.description, 'desc');
});

test('every archetype prompt stays within the negative-constraint budget', () => {
  for (const id of ARCHETYPE_IDS) {
    const spec = getArchetype(id)({ domain: 'a domain' });
    const prompts = [spec.persona, ...spec.agents.map((a) => a.prompt)];
    for (const p of prompts) {
      assert.ok(
        countNegativeConstraints(p) <= MAX_NEGATIVE_CONSTRAINTS,
        `${id} prompt over budget: ${countNegativeConstraints(p)}`,
      );
    }
  }
});

test('content-studio and review-team produce distinct domains and roles', () => {
  const studio = getArchetype('content-studio')({ domain: 'blog posts' });
  const review = getArchetype('review-team')({ domain: 'pull requests' });
  assert.equal(studio.name, 'blog-posts-studio');
  assert.equal(review.name, 'pull-requests-review');
  assert.deepEqual(studio.agents.map((a) => a.name), ['strategist', 'writer', 'editor']);
  assert.deepEqual(review.agents.map((a) => a.name), ['reviewer', 'auditor', 'synthesizer']);
});
