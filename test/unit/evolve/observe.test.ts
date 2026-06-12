import { test } from 'node:test';
import assert from 'node:assert/strict';

import { observe, type Reviewer } from '../../../src/evolve/observe.ts';
import type { RawObservation } from '../../../src/evolve/types.ts';
import type { NeutralMsg } from '../../../src/providers/types.ts';

function userMsg(text: string): NeutralMsg {
  return { role: 'user', blocks: [{ kind: 'text', text }] };
}
function asstMsg(text: string): NeutralMsg {
  return { role: 'assistant', blocks: [{ kind: 'text', text }] };
}

// A scripted reviewer: returns a fixed list regardless of input, but records
// the transcript text it was handed so we can assert observe() folds correctly.
function scriptedReviewer(raws: readonly RawObservation[]): { reviewer: Reviewer; seen: string[] } {
  const seen: string[] = [];
  const reviewer: Reviewer = async (transcript) => {
    seen.push(transcript);
    return raws;
  };
  return { reviewer, seen };
}

test('observe stamps each raw observation with a stable id and the sid', async () => {
  const { reviewer } = scriptedReviewer([
    { kind: 'friction', summary: 'kept apologizing', constraint: 'Skip apologies.' },
    { kind: 'missing_skill', summary: 'no diff tool', skill: 'apply-patch' },
  ]);
  const obs = await observe('sid-123', [userMsg('hi'), asstMsg('sorry, sorry')], reviewer);
  assert.equal(obs.length, 2);
  assert.equal(obs[0]!.sid, 'sid-123');
  assert.equal(obs[1]!.sid, 'sid-123');
  assert.equal(obs[0]!.id, 'sid-123#0');
  assert.equal(obs[1]!.id, 'sid-123#1');
  assert.equal(obs[0]!.kind, 'friction');
  if (obs[0]!.kind === 'friction') assert.equal(obs[0]!.constraint, 'Skip apologies.');
});

test('observe passes a role-tagged transcript to the reviewer', async () => {
  const { reviewer, seen } = scriptedReviewer([]);
  await observe('s', [userMsg('explain X'), asstMsg('here is X')], reviewer);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!, /\[user\] explain X/);
  assert.match(seen[0]!, /\[assistant\] here is X/);
});

test('observe returns empty for an empty transcript without calling the reviewer', async () => {
  let called = false;
  const reviewer: Reviewer = async () => {
    called = true;
    return [{ kind: 'friction', summary: 's', constraint: 'c' }];
  };
  const obs = await observe('s', [], reviewer);
  assert.deepEqual(obs, []);
  assert.equal(called, false);
});

test('observe drops malformed raw observations (unknown kind) defensively', async () => {
  const reviewer: Reviewer = async () =>
    [
      { kind: 'friction', summary: 'ok', constraint: 'c' },
      { kind: 'bogus', summary: 'nope' },
    ] as unknown as readonly RawObservation[];
  const obs = await observe('s', [userMsg('x')], reviewer);
  assert.equal(obs.length, 1);
  assert.equal(obs[0]!.kind, 'friction');
});
