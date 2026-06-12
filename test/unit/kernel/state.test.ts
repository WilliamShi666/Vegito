import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { initialState, replaceState } from '../../../src/kernel/state.ts';

describe('initialState', () => {
  test('builds the documented empty-session shape', () => {
    const s = initialState({ sid: 'S1', model: 'scripted-1' });
    assert.equal(s.sid, 'S1');
    assert.equal(s.model, 'scripted-1');
    assert.equal(s.turn, 0);
    assert.deepEqual(s.history, []);
    assert.equal(s.draft, null);
    assert.deepEqual(s.pendingCalls, []);
    assert.deepEqual(s.usage, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(s.lastStop, null);
    assert.ok(s.limits.maxIterations > 0);
  });

  test('accepts a maxIterations override', () => {
    const s = initialState({ sid: 'S1', model: 'm', maxIterations: 7 });
    assert.equal(s.limits.maxIterations, 7);
  });
});

describe('replaceState', () => {
  test('returns a new object with overrides applied; base is untouched', () => {
    const base = initialState({ sid: 'S1', model: 'm' });
    const next = replaceState(base, { turn: 1, lastStop: 'end_turn' });
    assert.notEqual(next, base);
    assert.equal(next.turn, 1);
    assert.equal(next.lastStop, 'end_turn');
    assert.equal(base.turn, 0);
    assert.equal(base.lastStop, null);
    assert.equal(next.sid, 'S1'); // unspecified fields carry over
  });

  test('result is deeply frozen — direct mutation throws in strict mode', () => {
    const s = replaceState(initialState({ sid: 'S1', model: 'm' }), {
      history: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
    });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.history));
    assert.ok(Object.isFrozen(s.history[0]));
    assert.ok(Object.isFrozen(s.history[0]?.blocks[0]));
    assert.throws(() => {
      (s as { turn: number }).turn = 99;
    }, TypeError);
    assert.throws(() => {
      (s.history as unknown[]).push('x');
    }, TypeError);
  });

  test('initialState is frozen too', () => {
    const s = initialState({ sid: 'S1', model: 'm' });
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.limits));
    assert.throws(() => {
      (s.limits as { maxIterations: number }).maxIterations = 0;
    }, TypeError);
  });
});
