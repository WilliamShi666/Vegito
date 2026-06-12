import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planFromFlags, inferPlan, interview, planToSpec } from '../../../src/forge/interview.ts';

test('planFromFlags requires a domain and a known archetype', () => {
  assert.deepEqual(planFromFlags({ archetype: 'tutor-team' }), {
    error: 'forge needs a --domain (or run without --offline to be asked)',
  });
  assert.deepEqual(planFromFlags({ archetype: 'bogus', domain: 'x' }), {
    error: 'unknown archetype "bogus" (known: tutor-team, review-team, content-studio)',
  });
  const ok = planFromFlags({ archetype: 'review-team', domain: 'Go services' });
  assert.deepEqual(ok, { archetype: 'review-team', params: { domain: 'Go services' } });
});

test('planFromFlags defaults the archetype and carries a name override', () => {
  const plan = planFromFlags({ domain: 'IELTS', name: 'my-pack' });
  assert.deepEqual(plan, { archetype: 'tutor-team', params: { domain: 'IELTS', name: 'my-pack' } });
});

test('inferPlan picks archetype by keyword vote and domain from the first heading', () => {
  const review = inferPlan('# Code Review Bot\nWe audit pull requests for security issues.');
  assert.equal(review.archetype, 'review-team');
  assert.equal(review.params.domain, 'Code Review Bot');

  const studio = inferPlan('Blog writing assistant\nDraft and edit marketing copy and articles.');
  assert.equal(studio.archetype, 'content-studio');

  const tutor = inferPlan('A tutor to teach and coach exam practice.');
  assert.equal(tutor.archetype, 'tutor-team');
});

test('inferPlan falls back to tutor-team and a placeholder domain on empty docs', () => {
  const plan = inferPlan('   \n  \n');
  assert.equal(plan.archetype, 'tutor-team');
  assert.equal(plan.params.domain, 'the documented domain');
});

test('interview drives through an ask port and builds a plan', async () => {
  const answers = ['review-team', 'pull requests', 'pr-reviewer'];
  let i = 0;
  const ask = async () => answers[i++]!;
  const plan = await interview(ask);
  assert.deepEqual(plan, { archetype: 'review-team', params: { domain: 'pull requests', name: 'pr-reviewer' } });
});

test('interview re-asks once on unknown archetype then falls back to default', async () => {
  const answers = ['nonsense', 'still-bad', 'IELTS writing', ''];
  let i = 0;
  const ask = async () => answers[i++]!;
  const plan = await interview(ask);
  assert.equal(plan.archetype, 'tutor-team');
  assert.equal(plan.params.domain, 'IELTS writing');
  assert.equal(plan.params.name, undefined);
});

test('interview uses defaults when answers are blank', async () => {
  const ask = async () => '';
  const plan = await interview(ask);
  assert.equal(plan.archetype, 'tutor-team');
  assert.equal(plan.params.domain, 'a general domain');
});

test('planToSpec resolves through the archetype template', () => {
  const spec = planToSpec({ archetype: 'content-studio', params: { domain: 'blog posts' } });
  assert.equal(spec.name, 'blog-posts-studio');
  assert.deepEqual(spec.agents.map((a) => a.name), ['strategist', 'writer', 'editor']);
});
