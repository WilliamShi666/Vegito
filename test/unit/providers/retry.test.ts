import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { backoffDelay, isRetryable, withRetries, DEFAULT_RETRY } from '../../../src/providers/retry.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';

describe('backoffDelay', () => {
  test('honors Retry-After exactly, capped by policy', () => {
    assert.equal(backoffDelay(1, DEFAULT_RETRY, 1200, () => 0.5), 1200);
    assert.equal(backoffDelay(1, DEFAULT_RETRY, 99_999_999, () => 0.5), DEFAULT_RETRY.capMs);
  });

  test('otherwise doubles per attempt with deterministic jitter', () => {
    const policy = { maxAttempts: 5, baseMs: 100, capMs: 1600 };
    // jitter()=1 → full delay; attempt 1: 100, 2: 200, 3: 400, capped at 1600
    assert.equal(backoffDelay(1, policy, undefined, () => 1), 100);
    assert.equal(backoffDelay(2, policy, undefined, () => 1), 200);
    assert.equal(backoffDelay(3, policy, undefined, () => 1), 400);
    assert.equal(backoffDelay(6, policy, undefined, () => 1), 1600);
    // jitter()=0 → half delay (never zero)
    assert.equal(backoffDelay(1, policy, undefined, () => 0), 50);
  });
});

describe('isRetryable', () => {
  test('429 / 408 / 5xx / explicit shouldRetry are retryable; 4xx are not', () => {
    assert.equal(isRetryable(new ProviderHttpError(429, 'rate')), true);
    assert.equal(isRetryable(new ProviderHttpError(408, 'timeout')), true);
    assert.equal(isRetryable(new ProviderHttpError(500, 'ise')), true);
    assert.equal(isRetryable(new ProviderHttpError(529, 'overloaded')), true);
    assert.equal(isRetryable(new ProviderHttpError(400, 'bad request')), false);
    assert.equal(isRetryable(new ProviderHttpError(401, 'unauthorized')), false);
    assert.equal(isRetryable(new ProviderHttpError(400, 'flagged', { shouldRetry: true })), true);
    assert.equal(isRetryable(new Error('plain')), false);
  });
});

describe('withRetries', () => {
  test('returns on success after transient failures, sleeping between attempts', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetries(
      async () => {
        calls++;
        if (calls < 3) throw new ProviderHttpError(429, 'rate', { retryAfterMs: 700 });
        return 'served';
      },
      {
        policy: { maxAttempts: 4, baseMs: 100, capMs: 1000 },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    assert.equal(result, 'served');
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [700, 700]); // Retry-After honored on both waits
  });

  test('non-retryable errors are rethrown immediately', async () => {
    let calls = 0;
    await assert.rejects(
      withRetries(
        async () => {
          calls++;
          throw new ProviderHttpError(401, 'unauthorized');
        },
        { policy: DEFAULT_RETRY, sleep: async () => {} },
      ),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 401,
    );
    assert.equal(calls, 1);
  });

  test('exhausting maxAttempts rethrows the last error', async () => {
    let calls = 0;
    await assert.rejects(
      withRetries(
        async () => {
          calls++;
          throw new ProviderHttpError(500, `attempt ${calls}`);
        },
        { policy: { maxAttempts: 3, baseMs: 1, capMs: 1 }, sleep: async () => {} },
      ),
      /attempt 3/,
    );
    assert.equal(calls, 3);
  });

  test('reports each retry with attempt number and delay', async () => {
    const notes: { attempt: number; delayMs: number }[] = [];
    let calls = 0;
    await withRetries(
      async () => {
        calls++;
        if (calls === 1) throw new ProviderHttpError(503, 'busy');
        return 'ok';
      },
      {
        policy: { maxAttempts: 2, baseMs: 100, capMs: 100 },
        sleep: async () => {},
        jitter: () => 1,
        onRetry: (attempt, delayMs) => notes.push({ attempt, delayMs }),
      },
    );
    assert.deepEqual(notes, [{ attempt: 1, delayMs: 100 }]);
  });
});
