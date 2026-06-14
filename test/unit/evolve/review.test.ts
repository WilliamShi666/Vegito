import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewer } from '../../../src/evolve/review.ts';
import type { CallModel } from '../../../src/ui/runtime.ts';
import type { NeutralRequest, ProviderEvent } from '../../../src/providers/types.ts';

// A scripted callModel that emits the given text as one text_delta and records
// the request it was handed.
function scripted(text: string): { call: CallModel; reqs: NeutralRequest[] } {
  const reqs: NeutralRequest[] = [];
  const call: CallModel = async function* (req: NeutralRequest): AsyncGenerator<ProviderEvent, void> {
    reqs.push(req);
    yield { t: 'text_delta', text };
  };
  return { call, reqs };
}

const signal = new AbortController().signal;

test('buildReviewer parses a JSON array of raw observations', async () => {
  const payload = JSON.stringify([
    { kind: 'friction', summary: 'too verbose', constraint: 'Lead with the answer.' },
    { kind: 'memory_candidate', summary: 'pref', fact: 'Prefers TS.', level: 'l1' },
  ]);
  const { call } = scripted(payload);
  const reviewer = buildReviewer(call, signal, 'tier:smart');
  const raws = await reviewer('[user] hi\n[assistant] sorry, here is a wall of text');
  assert.equal(raws.length, 2);
  assert.equal(raws[0]!.kind, 'friction');
  assert.equal(raws[1]!.kind, 'memory_candidate');
});

test('buildReviewer tolerates a fenced code block around the JSON', async () => {
  const payload = '```json\n[{"kind":"missing_skill","summary":"s","skill":"apply-patch"}]\n```';
  const { call } = scripted(payload);
  const reviewer = buildReviewer(call, signal);
  const raws = await reviewer('transcript');
  assert.equal(raws.length, 1);
  assert.equal(raws[0]!.kind, 'missing_skill');
});

test('buildReviewer returns [] on unparseable output rather than throwing', async () => {
  const { call } = scripted('I could not find anything notable.');
  const reviewer = buildReviewer(call, signal);
  assert.deepEqual(await reviewer('t'), []);
});

test('buildReviewer schema-validates each observation kind', async () => {
  const payload = JSON.stringify([
    { kind: 'friction', summary: 'ok', constraint: 'Lead with the answer.' },
    { kind: 'friction', summary: 'missing constraint' },
    { kind: 'rubric_drift', summary: 'missing guidance', rubric: 'band-score' },
    { kind: 'missing_skill', summary: 'bad skill type', skill: 7 },
    { kind: 'memory_candidate', summary: 'bad level', fact: 'Prefers TS.', level: 'l9' },
  ]);
  const { call } = scripted(payload);
  const reviewer = buildReviewer(call, signal);
  const raws = await reviewer('transcript');
  assert.equal(raws.length, 1);
  assert.equal(raws[0]!.kind, 'friction');
});

test('buildReviewer rejects oversized fields and secret-shaped memory facts', async () => {
  const huge = 'x'.repeat(5000);
  const secretLike = ['sk', 'this-is-a-secret-shaped-token'].join('-');
  const payload = JSON.stringify([
    { kind: 'friction', summary: huge, constraint: 'Lead with the answer.' },
    { kind: 'memory_candidate', summary: 'secret', fact: `DeepSeek key ${secretLike}`, level: 'l1' },
    { kind: 'memory_candidate', summary: 'ok', fact: 'User prefers concise TypeScript reviews.', level: 'l1' },
  ]);
  const { call } = scripted(payload);
  const reviewer = buildReviewer(call, signal);
  const raws = await reviewer('transcript');
  assert.equal(raws.length, 1);
  assert.equal(raws[0]!.kind, 'memory_candidate');
  if (raws[0]!.kind === 'memory_candidate') assert.equal(raws[0]!.fact, 'User prefers concise TypeScript reviews.');
});

test('buildReviewer sends the transcript in the user message and bounds tokens', async () => {
  const { call, reqs } = scripted('[]');
  const reviewer = buildReviewer(call, signal);
  await reviewer('[user] do the thing');
  assert.equal(reqs.length, 1);
  const req = reqs[0]!;
  assert.ok((req.maxTokens ?? Infinity) <= 2048);
  const userText = req.messages.map((m) => m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')).join('\n');
  assert.match(userText, /do the thing/);
});
