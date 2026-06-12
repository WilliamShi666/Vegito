import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeSkillTool } from '../../../../src/tools/builtin/skill.ts';
import type { SkillSource } from '../../../../src/tools/builtin/skill.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

const source: SkillSource = {
  list: () => [
    { name: 'tdd', description: 'Write the test first, watch it fail' },
    { name: 'review', description: 'Code review checklist' },
  ],
  load: async (name) => (name === 'tdd' ? '# TDD\nFull skill body here.' : undefined),
};

const ctx = () => mkCtx('/');

describe('skill builtin', () => {
  test('declares itself: read-class, parallel-safe', () => {
    const skill = makeSkillTool(source);
    assert.equal(skill.name, 'skill');
    assert.equal(skill.concurrencySafe({ name: 'tdd' }), true);
    assert.deepEqual(skill.permissionKey({ name: 'tdd' }), { tool: 'skill', action: 'read', target: 'tdd' });
  });

  test('progressive disclosure: description advertises names + one-liners, not bodies', () => {
    const skill = makeSkillTool(source);
    assert.ok(skill.description.includes('tdd'));
    assert.ok(skill.description.includes('Write the test first'));
    assert.ok(skill.description.includes('review'));
    assert.ok(!skill.description.includes('Full skill body'));
  });

  test('invoking loads the full body', async () => {
    const skill = makeSkillTool(source);
    const out = await skill.run({ name: 'tdd' }, ctx());
    assert.ok(out.content.includes('Full skill body here.'));
  });

  test('unknown skill → ModelFacingError listing what exists', async () => {
    const skill = makeSkillTool(source);
    await assert.rejects(
      skill.run({ name: 'ghost' }, ctx()),
      (err: unknown) => err instanceof ModelFacingError && err.message.includes('tdd') && err.message.includes('review'),
    );
  });

  test('empty source still yields a coherent description', () => {
    const skill = makeSkillTool({ list: () => [], load: async () => undefined });
    assert.ok(/no skills/i.test(skill.description), `got: ${skill.description}`);
  });
});
