import { test } from 'node:test';
import assert from 'node:assert/strict';

import { propose } from '../../../src/evolve/propose.ts';
import type { Observation, RawObservation } from '../../../src/evolve/types.ts';

function obs(id: string, raw: RawObservation): Observation {
  return { ...raw, id, sid: 's' };
}

test('friction observations collapse into one persona pack_edit citing every source', () => {
  const proposals = propose([
    obs('s#0', { kind: 'friction', summary: 'a', constraint: 'Lead with the answer.' }),
    obs('s#1', { kind: 'friction', summary: 'b', constraint: 'Cite file paths.' }),
  ]);
  const edits = proposals.filter((p) => p.kind === 'pack_edit');
  assert.equal(edits.length, 1);
  const e = edits[0]!;
  assert.equal(e.kind, 'pack_edit');
  if (e.kind !== 'pack_edit') return;
  assert.equal(e.target, 'persona.md');
  assert.match(e.text, /Lead with the answer\./);
  assert.match(e.text, /Cite file paths\./);
  assert.deepEqual([...e.provenance], ['s#0', 's#1']);
});

test('persona negative-constraint budget is respected at propose time', () => {
  // Three negative constraints proposed, baseline already at 3 → only 2 fit.
  const proposals = propose(
    [
      obs('s#0', { kind: 'friction', summary: 'a', constraint: 'Never guess at APIs.' }),
      obs('s#1', { kind: 'friction', summary: 'b', constraint: "Don't skip tests." }),
      obs('s#2', { kind: 'friction', summary: 'c', constraint: 'Avoid broad refactors.' }),
    ],
    { personaNegatives: 3 },
  );
  const e = proposals.find((p) => p.kind === 'pack_edit');
  assert.ok(e && e.kind === 'pack_edit');
  // 3 baseline + 2 new = 5 (the cap); the third negative constraint is dropped.
  assert.match(e.text, /Never guess at APIs\./);
  assert.match(e.text, /Don't skip tests\./);
  assert.doesNotMatch(e.text, /Avoid broad refactors\./);
});

test('non-negative constraints are never dropped by the budget', () => {
  const proposals = propose(
    [
      obs('s#0', { kind: 'friction', summary: 'a', constraint: 'Lead with the outcome.' }),
      obs('s#1', { kind: 'friction', summary: 'b', constraint: 'Prefer small files.' }),
    ],
    { personaNegatives: 5 },
  );
  const e = proposals.find((p) => p.kind === 'pack_edit');
  assert.ok(e && e.kind === 'pack_edit');
  assert.match(e.text, /Lead with the outcome\./);
  assert.match(e.text, /Prefer small files\./);
});

test('rubric drift produces one edit per rubric, grouped', () => {
  const proposals = propose([
    obs('s#0', { kind: 'rubric_drift', summary: 'a', rubric: 'Band Score', guidance: 'Weight coherence higher.' }),
    obs('s#1', { kind: 'rubric_drift', summary: 'b', rubric: 'Band Score', guidance: 'Penalize off-topic.' }),
    obs('s#2', { kind: 'rubric_drift', summary: 'c', rubric: 'Tone Check', guidance: 'Allow contractions.' }),
  ]);
  const edits = proposals.filter((p) => p.kind === 'pack_edit');
  const band = edits.find((e) => e.kind === 'pack_edit' && e.target === 'rubrics/band-score.prompt.md');
  const tone = edits.find((e) => e.kind === 'pack_edit' && e.target === 'rubrics/tone-check.prompt.md');
  assert.ok(band && band.kind === 'pack_edit');
  assert.ok(tone && tone.kind === 'pack_edit');
  assert.match(band.text, /Weight coherence higher\./);
  assert.match(band.text, /Penalize off-topic\./);
  assert.deepEqual([...band.provenance], ['s#0', 's#1']);
});

test('rubric drift is rejected when a known-rubrics allowlist is provided and the rubric is unknown', () => {
  const proposals = propose(
    [
      obs('s#0', { kind: 'rubric_drift', summary: 'known', rubric: 'band-score', guidance: 'Weight coherence higher.' }),
      obs('s#1', { kind: 'rubric_drift', summary: 'unknown', rubric: 'invented rubric', guidance: 'Do anything.' }),
    ],
    { knownRubrics: ['band-score'] },
  );
  const edits = proposals.filter((p) => p.kind === 'pack_edit');
  assert.equal(edits.length, 1);
  const e = edits[0]!;
  assert.equal(e.kind, 'pack_edit');
  if (e.kind !== 'pack_edit') return;
  assert.equal(e.target, 'rubrics/band-score.prompt.md');
  assert.match(e.text, /Weight coherence higher\./);
  assert.doesNotMatch(e.text, /Do anything\./);
});

test('missing skills collapse into one onboarding edit', () => {
  const proposals = propose([
    obs('s#0', { kind: 'missing_skill', summary: 'a', skill: 'apply-patch' }),
    obs('s#1', { kind: 'missing_skill', summary: 'b', skill: 'web-search' }),
  ]);
  const e = proposals.find((p) => p.kind === 'pack_edit' && p.target === 'onboarding.md');
  assert.ok(e && e.kind === 'pack_edit');
  assert.match(e.text, /apply-patch/);
  assert.match(e.text, /web-search/);
});

test('memory candidates become promotions up one level; l3 is terminal', () => {
  const proposals = propose([
    obs('s#0', { kind: 'memory_candidate', summary: 'a', fact: 'User prefers TS.', level: 'l1' }),
    obs('s#1', { kind: 'memory_candidate', summary: 'b', fact: 'Distilled style.', level: 'l3' }),
  ]);
  const proms = proposals.filter((p) => p.kind === 'memory_promote');
  assert.equal(proms.length, 1);
  const p = proms[0]!;
  assert.equal(p.kind, 'memory_promote');
  if (p.kind !== 'memory_promote') return;
  assert.equal(p.from, 'l1');
  assert.equal(p.to, 'l2');
  assert.equal(p.fact, 'User prefers TS.');
  assert.deepEqual([...p.provenance], ['s#0']);
});

test('propose is deterministic and assigns stable ids', () => {
  const input = [
    obs('s#0', { kind: 'friction', summary: 'a', constraint: 'Be terse.' }),
    obs('s#1', { kind: 'memory_candidate', summary: 'b', fact: 'f', level: 'l1' }),
  ];
  const a = propose(input);
  const b = propose(input);
  assert.deepEqual(a, b);
  for (const p of a) assert.match(p.id, /^prop#\d+$/);
});

test('no observations yields no proposals', () => {
  assert.deepEqual(propose([]), []);
});
