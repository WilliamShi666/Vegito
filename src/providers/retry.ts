// Retry with server-honoring backoff (DESIGN §5.4): Retry-After wins when
// present, exponential-with-jitter otherwise, non-retryable errors surface
// immediately. The clock is injected — tests never sleep for real.

import { ProviderHttpError } from './errors.ts';

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = Object.freeze({ maxAttempts: 4, baseMs: 500, capMs: 16000 });

export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs?: number,
  jitter: () => number = Math.random,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.capMs);
  const raw = Math.min(policy.capMs, policy.baseMs * 2 ** (attempt - 1));
  return Math.round(raw * (0.5 + 0.5 * jitter()));
}

export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  if (err.shouldRetry !== undefined) return err.shouldRetry;
  return err.status === 408 || err.status === 429 || err.status >= 500;
}

export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    policy: RetryPolicy;
    sleep: (ms: number) => Promise<void>;
    jitter?: () => number;
    onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  },
): Promise<T> {
  const { policy } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isRetryable(err) || attempt >= policy.maxAttempts) throw err;
      const retryAfterMs = err instanceof ProviderHttpError ? err.retryAfterMs : undefined;
      const delayMs = backoffDelay(attempt, policy, retryAfterMs, opts.jitter);
      opts.onRetry?.(attempt, delayMs, err);
      await opts.sleep(delayMs);
    }
  }
}
