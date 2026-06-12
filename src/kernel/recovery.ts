import { isRetryable } from '../providers/retry.ts';

// The recovery ladder (DESIGN §3.3, L9, cc/01). A model call that throws is
// not immediately fatal: an ordered registry of strategies gets a chance to
// turn the failure into a retry. Cheap strategies sit first (honor a server's
// Retry-After), expensive ones last (compact the context and retry). While any
// strategy can still act, the error is *withheld* — never appended to history —
// so a recovered turn shows no scar. Only when the whole ladder declines does
// the error surface (become model-facing or fatal).

export interface RecoveryContext {
  /** How many model calls have already been attempted this turn. */
  readonly attempt: number;
  /** Hard ceiling; a strategy must not propose a retry at or past this. */
  readonly maxAttempts: number;
}

export type RecoveryAction =
  | { kind: 'retry'; note?: string } // re-run the model call (a strategy already did its side effect)
  | { kind: 'surface' }; // ladder is exhausted; let the error out

export interface RecoveryStrategy {
  readonly name: string;
  /** Cheap predicate: is this strategy even relevant to this error? */
  matches(err: unknown): boolean;
  /**
   * Attempt recovery. Return a retry action (with any side effect already
   * performed) to stop the ladder, or undefined to pass to the next strategy.
   */
  attempt(err: unknown, ctx: RecoveryContext): Promise<RecoveryAction | undefined>;
}

export interface Recoverer {
  recover(err: unknown, ctx: RecoveryContext): Promise<RecoveryAction>;
}

export function createRecoverer(strategies: readonly RecoveryStrategy[]): Recoverer {
  return {
    async recover(err: unknown, ctx: RecoveryContext): Promise<RecoveryAction> {
      for (const strat of strategies) {
        if (!strat.matches(err)) continue;
        const action = await strat.attempt(err, ctx);
        if (action !== undefined) return action;
      }
      return { kind: 'surface' };
    },
  };
}

// ---- canonical strategies ------------------------------------------------

export interface RetryAfterOpts {
  sleep: (ms: number) => Promise<void>;
  /** Fallback wait when the server gave no Retry-After. */
  defaultMs?: number;
}

const DEFAULT_RETRY_AFTER_MS = 1000;

// Honor a retryable transport error: wait the server-stated delay (or a small
// default) and retry — but never past the attempt ceiling.
export function retryAfterStrategy(opts: RetryAfterOpts): RecoveryStrategy {
  return {
    name: 'retry-after',
    matches: (err) => isRetryable(err),
    async attempt(err, ctx): Promise<RecoveryAction | undefined> {
      if (ctx.attempt + 1 >= ctx.maxAttempts) return undefined; // out of budget: let it surface
      const retryAfterMs = (err as { retryAfterMs?: number }).retryAfterMs;
      await opts.sleep(retryAfterMs ?? opts.defaultMs ?? DEFAULT_RETRY_AFTER_MS);
      return { kind: 'retry', note: 'retry-after' };
    },
  };
}

export interface CompactRetryOpts {
  /** Recognize a context-overflow error (provider-specific). */
  isOverflow: (err: unknown) => boolean;
  /** Force a full compaction before retrying. */
  compact: () => Promise<void>;
}

// Last resort before surfacing: an overflow means the request was too big, so
// compact the history and retry once. Distinct from the per-turn proactive
// compaction — this fires reactively on a provider rejection.
export function compactRetryStrategy(opts: CompactRetryOpts): RecoveryStrategy {
  return {
    name: 'compact-retry',
    matches: (err) => opts.isOverflow(err),
    async attempt(_err, ctx): Promise<RecoveryAction | undefined> {
      if (ctx.attempt + 1 >= ctx.maxAttempts) return undefined;
      await opts.compact();
      return { kind: 'retry', note: 'compact-retry' };
    },
  };
}
