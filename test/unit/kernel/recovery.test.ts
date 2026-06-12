import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecoverer,
  retryAfterStrategy,
  compactRetryStrategy,
  type RecoveryStrategy,
} from '../../../src/kernel/recovery.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';

test('an empty ladder surfaces every error', async () => {
  const r = createRecoverer([]);
  const action = await r.recover(new Error('boom'), { attempt: 0, maxAttempts: 5 });
  assert.deepEqual(action, { kind: 'surface' });
});

test('strategies are consulted in order; the first match wins and stops the ladder', async () => {
  const calls: string[] = [];
  const first: RecoveryStrategy = {
    name: 'first',
    matches: () => true,
    attempt: async () => {
      calls.push('first');
      return { kind: 'retry', note: 'first-handled' };
    },
  };
  const second: RecoveryStrategy = {
    name: 'second',
    matches: () => true,
    attempt: async () => {
      calls.push('second');
      return { kind: 'retry' };
    },
  };
  const r = createRecoverer([first, second]);
  const action = await r.recover(new Error('x'), { attempt: 0, maxAttempts: 5 });
  assert.deepEqual(action, { kind: 'retry', note: 'first-handled' });
  assert.deepEqual(calls, ['first'], 'second strategy never consulted once first handled');
});

test('a non-matching or passing strategy falls through to the next', async () => {
  const passes: RecoveryStrategy = {
    name: 'passes',
    matches: () => false,
    attempt: async () => ({ kind: 'retry' }),
  };
  const handles: RecoveryStrategy = {
    name: 'handles',
    matches: () => true,
    attempt: async () => ({ kind: 'retry', note: 'real' }),
  };
  const r = createRecoverer([passes, handles]);
  assert.deepEqual(await r.recover(new Error('x'), { attempt: 0, maxAttempts: 5 }), {
    kind: 'retry',
    note: 'real',
  });
});

test('a strategy that returns undefined from attempt() passes to the next', async () => {
  const undecided: RecoveryStrategy = {
    name: 'undecided',
    matches: () => true,
    attempt: async () => undefined,
  };
  const r = createRecoverer([undecided]);
  assert.deepEqual(await r.recover(new Error('x'), { attempt: 0, maxAttempts: 5 }), { kind: 'surface' });
});

test('retryAfterStrategy sleeps the server-honored delay then retries, bounded by maxAttempts', async () => {
  const slept: number[] = [];
  const strat = retryAfterStrategy({ sleep: async (ms) => void slept.push(ms) });
  const err = new ProviderHttpError(429, 'rate limited', { retryAfterMs: 1500 });

  const r = createRecoverer([strat]);
  const a1 = await r.recover(err, { attempt: 0, maxAttempts: 3 });
  assert.equal(a1.kind, 'retry');
  assert.deepEqual(slept, [1500]);

  // once attempts are spent, the same error surfaces instead of looping forever
  const a2 = await r.recover(err, { attempt: 3, maxAttempts: 3 });
  assert.equal(a2.kind, 'surface');
});

test('retryAfterStrategy ignores non-retryable errors', async () => {
  const strat = retryAfterStrategy({ sleep: async () => {} });
  const r = createRecoverer([strat]);
  const a = await r.recover(new ProviderHttpError(400, 'bad request', {}), { attempt: 0, maxAttempts: 3 });
  assert.equal(a.kind, 'surface');
});

test('compactRetryStrategy fires once on an overflow error, compacting before retry', async () => {
  let compacted = 0;
  const strat = compactRetryStrategy({
    isOverflow: (e) => e instanceof Error && e.message.includes('context'),
    compact: async () => void compacted++,
  });
  const r = createRecoverer([strat]);

  const a = await r.recover(new Error('context window exceeded'), { attempt: 0, maxAttempts: 3 });
  assert.equal(a.kind, 'retry');
  assert.equal(compacted, 1);

  // a non-overflow error is left for another strategy
  const b = await r.recover(new Error('unrelated'), { attempt: 0, maxAttempts: 3 });
  assert.equal(b.kind, 'surface');
});

test('the canonical ladder tries retry-after before compaction', async () => {
  const order: string[] = [];
  const r = createRecoverer([
    {
      name: 'retry-after',
      matches: (e) => e instanceof ProviderHttpError,
      attempt: async () => {
        order.push('retry-after');
        return { kind: 'retry' };
      },
    },
    {
      name: 'compact',
      matches: () => true,
      attempt: async () => {
        order.push('compact');
        return { kind: 'retry' };
      },
    },
  ]);
  await r.recover(new ProviderHttpError(503, 'unavailable', {}), { attempt: 0, maxAttempts: 3 });
  assert.deepEqual(order, ['retry-after']);
});
