// SessionState (DESIGN §3.2): the loop's entire mutable world, held as an
// immutable value. replaceState is the sole constructor of new states and
// deep-freezes every result — accidental mutation throws, always, not just
// in dev builds.

import type { Block, NeutralMsg, Usage, StopReason } from '../providers/types.ts';
import { ZERO_USAGE } from '../providers/types.ts';

export interface PendingCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface SessionState {
  readonly sid: string;
  readonly model: string;
  readonly turn: number;
  readonly history: readonly NeutralMsg[];
  // Assistant message under construction while a model response streams.
  readonly draft: readonly Block[] | null;
  readonly pendingCalls: readonly PendingCall[];
  readonly usage: Usage;
  readonly lastStop: StopReason | null;
  readonly limits: { readonly maxIterations: number };
}

export const DEFAULT_MAX_ITERATIONS = 50;

function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as object;
  if (seen.has(obj)) return value;
  seen.add(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    deepFreeze((obj as Record<string, unknown>)[key], seen);
  }
  Object.freeze(obj);
  return value;
}

export function initialState(init: { sid: string; model: string; maxIterations?: number }): SessionState {
  return replaceState(
    {
      sid: init.sid,
      model: init.model,
      turn: 0,
      history: [],
      draft: null,
      pendingCalls: [],
      usage: ZERO_USAGE,
      lastStop: null,
      limits: { maxIterations: init.maxIterations ?? DEFAULT_MAX_ITERATIONS },
    },
    {},
  );
}

export function replaceState(base: SessionState, overrides: Partial<SessionState>): SessionState {
  return deepFreeze({ ...base, ...overrides }, new WeakSet());
}
