import type { LoopEvent, ExitReason } from './events.ts';
import type { SessionState } from './state.ts';
import { reduce } from './reducer.ts';
import { executeTools, type ExecDeps } from './executor.ts';
import type { Recoverer } from './recovery.ts';
import type { NeutralRequest, ProviderEvent } from '../providers/types.ts';

// runTurn (DESIGN §3.2): the kernel's single turn as an async generator. It
// composes the provider call (§5), the reducer (§3.1), tool execution (§7),
// and recovery (§3.3) into one deterministic stream of LoopEvents, returning a
// typed ExitReason on every path. Effects (transcript append, trace) are the
// caller's job — runTurn is pure orchestration over injected deps, which is
// what lets the whole loop run against a scripted provider in tests (D11).

export interface TurnResult {
  state: SessionState;
  reason: ExitReason;
}

export interface LoopDeps {
  /** Display name of the active provider (for model_call events). */
  providerName: string;
  /** Build the neutral request from current state (context assembly, §6). */
  assembleRequest: (s: SessionState) => NeutralRequest;
  /** Stream a model response. Throws on transport failure (recovery decides). */
  callModel: (req: NeutralRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>;
  /** Tool execution pipeline deps (gate, budget, registry, engine, ctx). */
  exec: ExecDeps;
  /** The recovery ladder consulted when a model call throws. */
  recoverer: Recoverer;
  /** Turn-level abort. */
  signal: AbortSignal;
  /** Hard ceiling on model calls within one turn (recovery budget). */
  maxAttempts: number;
}

// Map a reducer-consumed provider event to its public LoopEvent, if any.
// msg_start / tool_call carry no user-facing delta; msg_end is surfaced as
// part of turn flow, not echoed here.
function toLoopEvent(ev: ProviderEvent): LoopEvent | undefined {
  switch (ev.t) {
    case 'text_delta':
      return { t: 'text_delta', text: ev.text };
    case 'thinking_delta':
      return { t: 'thinking_delta', text: ev.text };
    case 'tool_call':
      return { t: 'tool_start', callId: ev.callId, name: ev.name, input: ev.input };
    default:
      return undefined;
  }
}

export async function* runTurn(initial: SessionState, deps: LoopDeps): AsyncGenerator<LoopEvent, TurnResult> {
  let state = reduce(initial, { t: 'turn_start' });
  yield { t: 'turn_start', turn: state.turn };

  let attempt = 0;
  for (let i = 0; ; i++) {
    if (deps.signal.aborted) {
      yield { t: 'turn_end', reason: 'interrupted', usage: state.usage };
      return { state, reason: 'interrupted' };
    }
    if (i >= state.limits.maxIterations) {
      yield { t: 'turn_end', reason: 'max_iterations', usage: state.usage };
      return { state, reason: 'max_iterations' };
    }

    // --- model call with withholding recovery -----------------------------
    // We fold provider events into a scratch state and only commit it if the
    // stream completes. A mid-stream failure discards the partial draft (the
    // error is withheld from history while the ladder still has moves, cc/01).
    let committed: SessionState | undefined;
    for (;;) {
      if (deps.signal.aborted) {
        yield { t: 'turn_end', reason: 'interrupted', usage: state.usage };
        return { state, reason: 'interrupted' };
      }
      yield { t: 'model_call', provider: deps.providerName, model: state.model, attempt: attempt + 1 };
      attempt += 1;
      const req = deps.assembleRequest(state);
      let scratch = state;
      const pending: LoopEvent[] = [];
      try {
        for await (const ev of deps.callModel(req, deps.signal)) {
          scratch = reduce(scratch, ev);
          const le = toLoopEvent(ev);
          if (le !== undefined) pending.push(le);
        }
        committed = scratch;
      } catch (err) {
        if (deps.signal.aborted) {
          yield { t: 'turn_end', reason: 'interrupted', usage: state.usage };
          return { state, reason: 'interrupted' };
        }
        const action = await deps.recoverer.recover(err, { attempt, maxAttempts: deps.maxAttempts });
        if (action.kind === 'retry') {
          if (action.note !== undefined) yield { t: 'notice', level: 'info', text: `recovered: ${action.note}` };
          continue; // re-run the model call; partial draft discarded
        }
        yield { t: 'notice', level: 'warn', text: err instanceof Error ? err.message : String(err) };
        yield { t: 'turn_end', reason: 'fatal_error', usage: state.usage };
        return { state, reason: 'fatal_error' };
      }
      // success: flush the held events now that the stream completed cleanly
      for (const le of pending) yield le;
      break;
    }
    state = committed;

    // --- end of turn? -----------------------------------------------------
    if (state.pendingCalls.length === 0) {
      yield { t: 'turn_end', reason: 'end_turn', usage: state.usage };
      return { state, reason: 'end_turn' };
    }

    // --- tool execution ---------------------------------------------------
    const results = yield* executeTools(state.pendingCalls, deps.exec);
    state = reduce(state, { t: 'tool_results', results });
  }
}
