import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_VERSION,
  FoldError,
  headerRec,
  msgRec,
  compactRec,
  forkRec,
  metaRec,
  isHeader,
  isMsg,
  isCompact,
  isFork,
  isMeta,
  parseRec,
  fold,
} from '../../../src/sessions/records.ts';
import type { NeutralMsg } from '../../../src/providers/types.ts';

function userText(text: string): NeutralMsg {
  return { role: 'user', blocks: [{ kind: 'text', text }] };
}
function asstText(text: string): NeutralMsg {
  return { role: 'assistant', blocks: [{ kind: 'text', text }] };
}

test('RECORD_VERSION is 1', () => {
  assert.equal(RECORD_VERSION, 1);
});

test('headerRec carries v:1 + identity fields', () => {
  const h = headerRec('sid-1', '2026-06-12T00:00:00.000Z', '0.1.0');
  assert.deepEqual(h, {
    v: 1,
    t: 'header',
    sid: 'sid-1',
    created: '2026-06-12T00:00:00.000Z',
    appVersion: '0.1.0',
  });
  assert.ok(isHeader(h));
  assert.ok(!isMsg(h));
});

test('msgRec/compactRec/forkRec/metaRec produce discriminated shapes', () => {
  const m = msgRec(1, 'r1', null, userText('hi'));
  assert.deepEqual(m, { seq: 1, id: 'r1', parent: null, t: 'msg', msg: userText('hi') });
  assert.ok(isMsg(m));

  const c = compactRec(5, 'r5', 'r4', ['r1', 'r4'], asstText('summary'));
  assert.deepEqual(c, {
    seq: 5,
    id: 'r5',
    parent: 'r4',
    t: 'compact',
    replaces: ['r1', 'r4'],
    summary: asstText('summary'),
  });
  assert.ok(isCompact(c));

  const f = forkRec(0, 'r0', null, 'parent-sid', 'r9');
  assert.deepEqual(f, { seq: 0, id: 'r0', parent: null, t: 'fork', fromSid: 'parent-sid', at: 'r9' });
  assert.ok(isFork(f));

  const meta = metaRec(7, 'r7', 'r6', 'latch_break', { reason: 'model-changed' });
  assert.deepEqual(meta, {
    seq: 7,
    id: 'r7',
    parent: 'r6',
    t: 'meta',
    k: 'latch_break',
    p: { reason: 'model-changed' },
  });
  assert.ok(isMeta(meta));
});

test('type guards are mutually exclusive', () => {
  const recs = [
    headerRec('s', 'c', 'v'),
    msgRec(1, 'r1', null, userText('a')),
    compactRec(2, 'r2', 'r1', ['r1', 'r1'], asstText('s')),
    forkRec(0, 'r0', null, 's2', 'rX'),
    metaRec(3, 'r3', 'r2', 'k', 1),
  ];
  for (const r of recs) {
    const hits = [isHeader, isMsg, isCompact, isFork, isMeta].filter((g) => g(r)).length;
    assert.equal(hits, 1, `exactly one guard should match ${JSON.stringify(r)}`);
  }
});

test('parseRec accepts well-formed records (round-trips through JSON)', () => {
  const samples = [
    headerRec('sid', '2026-06-12T00:00:00.000Z', '0.1.0'),
    msgRec(1, 'r1', null, userText('hi')),
    compactRec(2, 'r2', 'r1', ['r1', 'r1'], asstText('sum')),
    forkRec(0, 'r0', null, 'sidP', 'rA'),
    metaRec(3, 'r3', 'r2', 'note', { any: 'json' }),
  ];
  for (const s of samples) {
    const round = JSON.parse(JSON.stringify(s));
    assert.deepEqual(parseRec(round), s);
  }
});

test('parseRec rejects malformed records', () => {
  assert.throws(() => parseRec(null), /record/i);
  assert.throws(() => parseRec(42), /record/i);
  assert.throws(() => parseRec({ t: 'unknown' }), /unknown|type/i);
  assert.throws(() => parseRec({ t: 'header', sid: 's', created: 'c' }), /version|appVersion|v/i);
  assert.throws(() => parseRec({ v: 2, t: 'header', sid: 's', created: 'c', appVersion: 'v' }), /version/i);
  // msg with non-numeric seq
  assert.throws(() => parseRec({ seq: 'x', id: 'r', parent: null, t: 'msg', msg: userText('a') }), /seq/i);
  // compact with a bad replaces tuple
  assert.throws(
    () => parseRec({ seq: 1, id: 'r', parent: null, t: 'compact', replaces: ['only-one'], summary: asstText('s') }),
    /replaces/i,
  );
  // msg with a structurally invalid NeutralMsg
  assert.throws(() => parseRec({ seq: 1, id: 'r', parent: null, t: 'msg', msg: { role: 'system', blocks: [] } }), /role|msg/i);
});

test('fold: messages only — preserved in seq order', () => {
  const recs = [
    headerRec('s', 'c', 'v'),
    msgRec(1, 'r1', null, userText('first')),
    msgRec(2, 'r2', 'r1', asstText('second')),
    msgRec(3, 'r3', 'r2', userText('third')),
  ];
  assert.deepEqual(fold(recs), [userText('first'), asstText('second'), userText('third')]);
});

test('fold: compact replaces a contiguous range in place', () => {
  const recs = [
    headerRec('s', 'c', 'v'),
    msgRec(1, 'r1', null, userText('m1')),
    msgRec(2, 'r2', 'r1', asstText('m2')),
    msgRec(3, 'r3', 'r2', userText('m3')),
    msgRec(4, 'r4', 'r3', asstText('m4')),
    // collapse r1..r3 into one summary; r4 (the protected tail) survives
    compactRec(5, 'c5', 'r4', ['r1', 'r3'], asstText('SUMMARY(1-3)')),
  ];
  assert.deepEqual(fold(recs), [asstText('SUMMARY(1-3)'), asstText('m4')]);
});

test('fold: iterative compaction yields a single running summary', () => {
  const recs = [
    headerRec('s', 'c', 'v'),
    msgRec(1, 'r1', null, userText('m1')),
    msgRec(2, 'r2', 'r1', asstText('m2')),
    compactRec(3, 'c3', 'r2', ['r1', 'r2'], asstText('S1')),
    msgRec(4, 'r4', 'c3', userText('m4')),
    msgRec(5, 'r5', 'r4', asstText('m5')),
    // second compaction folds the prior summary + new turns into one summary
    compactRec(6, 'c6', 'r5', ['c3', 'r5'], asstText('S2')),
  ];
  assert.deepEqual(fold(recs), [asstText('S2')]);
});

test('fold: header/fork/meta never appear in the model-facing array', () => {
  const recs = [
    headerRec('s', 'c', 'v'),
    forkRec(0, 'r0', null, 'parentSid', 'rZ'),
    msgRec(1, 'r1', 'r0', userText('m1')),
    metaRec(2, 'r2', 'r1', 'latch_break', {}),
    msgRec(3, 'r3', 'r2', asstText('m3')),
  ];
  assert.deepEqual(fold(recs), [userText('m1'), asstText('m3')]);
});

test('fold: compact referencing an unknown range throws FoldError', () => {
  const recs = [
    msgRec(1, 'r1', null, userText('m1')),
    compactRec(2, 'c2', 'r1', ['ghost', 'r1'], asstText('S')),
  ];
  assert.throws(() => fold(recs), FoldError);
});

test('fold: compact with an inverted range throws FoldError', () => {
  const recs = [
    msgRec(1, 'r1', null, userText('m1')),
    msgRec(2, 'r2', 'r1', asstText('m2')),
    compactRec(3, 'c3', 'r2', ['r2', 'r1'], asstText('S')),
  ];
  assert.throws(() => fold(recs), FoldError);
});
