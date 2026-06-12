// The recovery ladder's orchestrator (DESIGN §5.4): walk an ordered list of
// targets; within one, rotate credentials on auth death and retry with
// server-honoring backoff; hop to the next on exhaustion. A stream that
// already delivered events is never silently retried — replaying a prefix
// would corrupt the transcript, so mid-stream failures surface to the kernel.

import type { NeutralRequest, ProviderEvent, WireProtocol } from './types.ts';
import type { CredentialPool } from './credentials.ts';
import { ProviderHttpError } from './errors.ts';
import { backoffDelay, isRetryable, type RetryPolicy } from './retry.ts';
import { withStallGuard, type StallOpts } from './stream.ts';

export interface FailoverTarget {
  readonly name: string;
  readonly model: string;
  readonly wire: WireProtocol;
  readonly pool: CredentialPool;
}

export interface FailoverOpts {
  targets: readonly FailoverTarget[];
  retry: RetryPolicy;
  stall?: StallOpts;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  notice?: (text: string) => void;
}

/** Internal: this target is spent; the chain should move on. */
class TargetFailure extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'TargetFailure';
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class FailoverChain {
  #targets: readonly FailoverTarget[];
  #retry: RetryPolicy;
  #stall: StallOpts | undefined;
  #sleep: (ms: number) => Promise<void>;
  #jitter: () => number;
  #notice: (text: string) => void;

  constructor(opts: FailoverOpts) {
    this.#targets = opts.targets;
    this.#retry = opts.retry;
    this.#stall = opts.stall;
    this.#sleep = opts.sleep ?? realSleep;
    this.#jitter = opts.jitter ?? Math.random;
    this.#notice = opts.notice ?? (() => {});
  }

  async *send(req: NeutralRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const failures: string[] = [];
    for (const [i, target] of this.#targets.entries()) {
      try {
        yield* this.#viaTarget(target, req, signal);
        return;
      } catch (err) {
        if (!(err instanceof TargetFailure)) throw err; // not the chain's to recover
        failures.push(`${target.name}: ${err.message}`);
        const next = this.#targets[i + 1];
        this.#notice(
          `provider ${target.name}: ${err.message}${next === undefined ? '' : `; failing over to ${next.name}`}`,
        );
      }
    }
    throw new ProviderHttpError(503, `all providers failed — ${failures.join('; ')}`);
  }

  async *#viaTarget(target: FailoverTarget, req: NeutralRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const sent: NeutralRequest = { ...req, model: target.model };
    for (let attempt = 1; ; ) {
      if (signal.aborted) throw signal.reason;
      const cred = target.pool.current();
      if (cred === undefined) throw new TargetFailure('no usable credential');
      let emitted = false;
      try {
        const source = target.wire.send(sent, signal);
        const guarded = this.#stall === undefined ? source : withStallGuard(source, this.#stall);
        for await (const ev of guarded) {
          emitted = true;
          yield ev;
        }
        target.pool.reportSuccess(cred.id);
        return;
      } catch (err) {
        if (emitted) throw err; // partial stream already delivered: kernel's call now
        if (!(err instanceof ProviderHttpError)) throw err;
        target.pool.reportFailure(cred.id, err.status, err.retryAfterMs);
        if (err.status === 401 || err.status === 403) {
          const next = target.pool.current();
          if (next === undefined) {
            throw new TargetFailure(`credential ${cred.id} rejected (${err.status}), pool exhausted`, err);
          }
          this.#notice(
            `provider ${target.name}: credential ${cred.id} rejected (${err.status}); rotating to ${next.id}`,
          );
          continue; // rotation is its own ladder rung: immediate, not counted as a retry
        }
        if (!isRetryable(err)) throw err;
        if (attempt >= this.#retry.maxAttempts) {
          throw new TargetFailure(`HTTP ${err.status} after ${attempt} attempts (${err.message})`, err);
        }
        const delayMs = backoffDelay(attempt, this.#retry, err.retryAfterMs, this.#jitter);
        this.#notice(
          `provider ${target.name}: HTTP ${err.status}; retrying in ${delayMs}ms (attempt ${attempt}/${this.#retry.maxAttempts})`,
        );
        await this.#sleep(delayMs);
        attempt += 1;
      }
    }
  }
}
