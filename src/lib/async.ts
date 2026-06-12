// Async primitives used across the kernel: externally-settled promises (asks),
// first-wins claims (multi-UI ask resolution), serialized executors (write
// gates), and labeled timeouts (stream stall detection).

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly settled: boolean;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let settle!: (value: T | PromiseLike<T>) => void;
  let fail!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    settle = res;
    fail = rej;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    resolve(value) {
      if (settled) return;
      settled = true;
      settle(value);
    },
    reject(reason) {
      if (settled) return;
      settled = true;
      fail(reason);
    },
  };
}

export type ClaimResult<R> = { claimed: true; value: R } | { claimed: false };

// First caller wins; the flag flips before fn runs, so reentrant calls lose.
export function claimOnce<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => ClaimResult<R> {
  let claimed = false;
  return (...args) => {
    if (claimed) return { claimed: false };
    claimed = true;
    return { claimed: true, value: fn(...args) };
  };
}

// Serialized executor: tasks run strictly one at a time, FIFO; a failure
// rejects its own caller but never blocks the chain.
export function sequential(): <T>(task: () => T | Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => T | Promise<T>): Promise<T> => {
    const run = tail.then(() => task());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
