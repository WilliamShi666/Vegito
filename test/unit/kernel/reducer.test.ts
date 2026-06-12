import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { initialState } from '../../../src/kernel/state.ts';
import { reduce, type ReducerEvent } from '../../../src/kernel/reducer.ts';

const boot = () => initialState({ sid: 'S1', model: 'scripted-1' });

function fold(events: readonly ReducerEvent[]) {
  return events.reduce((s, ev) => reduce(s, ev), boot());
}

describe('reduce — a full scripted episode', () => {
  const episode: ReducerEvent[] = [
    { t: 'user_msg', blocks: [{ kind: 'text', text: 'list files' }] },
    { t: 'turn_start' },
    { t: 'msg_start', model: 'scripted-1' },
    { t: 'text_delta', text: 'Let me ' },
    { t: 'text_delta', text: 'look.' },
    { t: 'tool_call', callId: 'c1', name: 'ls', input: { path: '.' } },
    { t: 'msg_end', stop: 'tool_use', usage: { in: 10, out: 4, cacheRead: 0, cacheWrite: 2 } },
    { t: 'tool_results', results: [{ callId: 'c1', ok: true, content: 'a.ts\nb.ts' }] },
    { t: 'msg_start', model: 'scripted-1' },
    { t: 'text_delta', text: 'Two files.' },
    { t: 'msg_end', stop: 'end_turn', usage: { in: 20, out: 3, cacheRead: 12, cacheWrite: 0 } },
  ];

  test('produces the exact documented history', () => {
    const s = fold(episode);
    assert.deepEqual(s.history, [
      { role: 'user', blocks: [{ kind: 'text', text: 'list files' }] },
      {
        role: 'assistant',
        blocks: [
          { kind: 'text', text: 'Let me look.' },
          { kind: 'tool_call', callId: 'c1', name: 'ls', input: { path: '.' } },
        ],
      },
      { role: 'user', blocks: [{ kind: 'tool_result', callId: 'c1', ok: true, content: 'a.ts\nb.ts' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'Two files.' }] },
    ]);
    assert.equal(s.turn, 1);
    assert.equal(s.draft, null);
    assert.deepEqual(s.pendingCalls, []);
    assert.equal(s.lastStop, 'end_turn');
    assert.deepEqual(s.usage, { in: 30, out: 7, cacheRead: 12, cacheWrite: 2 });
  });

  test('is deterministic — same fold twice gives deepEqual states', () => {
    assert.deepEqual(fold(episode), fold(episode));
  });

  test('every intermediate state is frozen', () => {
    let s = boot();
    for (const ev of episode) {
      s = reduce(s, ev);
      assert.ok(Object.isFrozen(s));
      assert.ok(Object.isFrozen(s.history));
    }
  });
});

describe('reduce — delta merging', () => {
  test('consecutive same-kind deltas merge; kind switches start new blocks', () => {
    const s = fold([
      { t: 'turn_start' },
      { t: 'msg_start', model: 'm' },
      { t: 'thinking_delta', text: 'hm' },
      { t: 'thinking_delta', text: 'm…' },
      { t: 'text_delta', text: 'Plan: ' },
      { t: 'text_delta', text: 'read it' },
      { t: 'thinking_delta', text: 'again' },
      { t: 'msg_end', stop: 'end_turn', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
    ]);
    assert.deepEqual(s.history.at(-1)?.blocks, [
      { kind: 'thinking', text: 'hmm…' },
      { kind: 'text', text: 'Plan: read it' },
      { kind: 'thinking', text: 'again' },
    ]);
  });
});

describe('reduce — protocol violations throw', () => {
  test('text_delta before msg_start', () => {
    assert.throws(() => fold([{ t: 'turn_start' }, { t: 'text_delta', text: 'x' }]), /msg_start/);
  });

  test('tool_results with an unknown callId', () => {
    assert.throws(
      () =>
        fold([
          { t: 'turn_start' },
          { t: 'msg_start', model: 'm' },
          { t: 'tool_call', callId: 'c1', name: 'ls', input: {} },
          { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
          { t: 'tool_results', results: [{ callId: 'NOPE', ok: true, content: '' }] },
        ]),
      /NOPE/,
    );
  });
});

describe('reduce — pending call bookkeeping', () => {
  test('partial tool_results leave the remainder pending', () => {
    const s = fold([
      { t: 'turn_start' },
      { t: 'msg_start', model: 'm' },
      { t: 'tool_call', callId: 'c1', name: 'read', input: { path: 'a' } },
      { t: 'tool_call', callId: 'c2', name: 'read', input: { path: 'b' } },
      { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      { t: 'tool_results', results: [{ callId: 'c1', ok: true, content: 'A' }] },
    ]);
    assert.deepEqual(s.pendingCalls, [{ callId: 'c2', name: 'read', input: { path: 'b' } }]);
  });
});

describe('reducer purity (D2)', () => {
  test('reducer.ts imports no node: modules — no effects possible', async () => {
    const src = await readFile(new URL('../../../src/kernel/reducer.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] ?? '');
    assert.ok(imports.length > 0);
    for (const spec of imports) {
      assert.ok(!spec.startsWith('node:'), `reducer must stay platform-pure, found import '${spec}'`);
    }
  });
});
