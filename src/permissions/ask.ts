// The ask broker (DESIGN §7.2): permissions never talk to a terminal. When a
// verdict needs a human, the engine opens an ask and awaits a Deferred; the
// loop surfaces it as an `ask` LoopEvent and a UI settles it by id. claimOnce
// guarantees exactly one resolver wins even if a keypress and a timeout race.

import type { AskSpec } from '../kernel/events.ts';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  /** Atomically take ownership of the single settle; true only for the winner. */
  claimOnce(): boolean;
  /** Resolve the promise; no-op after the first resolve. */
  resolve(value: T): void;
}

export function createDeferred<T>(): Deferred<T> {
  let settle: (value: T) => void;
  const promise = new Promise<T>((res) => {
    settle = res;
  });
  let claimed = false;
  let resolved = false;
  return {
    promise,
    claimOnce(): boolean {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    resolve(value: T): void {
      if (resolved) return;
      resolved = true;
      settle(value);
    },
  };
}

export interface OpenAsk<T> {
  readonly askId: string;
  readonly spec: AskSpec;
  readonly promise: Promise<T>;
}

export interface PendingAsk {
  readonly askId: string;
  readonly spec: AskSpec;
}

export interface AskBroker<T> {
  open(spec: AskSpec): OpenAsk<T>;
  /** Settle a pending ask by id; false if unknown or already settled. */
  settle(askId: string, value: T): boolean;
  pending(): readonly PendingAsk[];
  /** Settle every still-pending ask with a fallback (used on shutdown). */
  rejectAll(value: T): void;
}

export function createAskBroker<T = string>(): AskBroker<T> {
  const open = new Map<string, { spec: AskSpec; deferred: Deferred<T> }>();
  let counter = 0;

  return {
    open(spec: AskSpec): OpenAsk<T> {
      counter += 1;
      const askId = `ask-${counter}`;
      const deferred = createDeferred<T>();
      open.set(askId, { spec, deferred });
      return { askId, spec, promise: deferred.promise };
    },
    settle(askId: string, value: T): boolean {
      const entry = open.get(askId);
      if (entry === undefined) return false;
      if (!entry.deferred.claimOnce()) return false;
      open.delete(askId);
      entry.deferred.resolve(value);
      return true;
    },
    pending(): readonly PendingAsk[] {
      return [...open.entries()].map(([askId, { spec }]) => ({ askId, spec }));
    },
    rejectAll(value: T): void {
      for (const [askId, entry] of [...open.entries()]) {
        if (entry.deferred.claimOnce()) {
          open.delete(askId);
          entry.deferred.resolve(value);
        }
      }
    },
  };
}
