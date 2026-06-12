// The pure reducer (D2): the ONLY place session state transitions. No I/O,
// no node: imports, no clocks — a fold over events is fully deterministic,
// which is what makes transcripts replayable and the loop testable.

import type { Block, ProviderEvent } from '../providers/types.ts';
import { addUsage } from '../providers/types.ts';
import type { SessionState, PendingCall } from './state.ts';
import { replaceState } from './state.ts';

export interface ToolResultInput {
  callId: string;
  ok: boolean;
  content: string;
}

export type ReducerEvent =
  | ProviderEvent
  | { t: 'turn_start' }
  | { t: 'user_msg'; blocks: readonly Block[] }
  | { t: 'tool_results'; results: readonly ToolResultInput[] };

function appendDelta(draft: readonly Block[], kind: 'text' | 'thinking', text: string): Block[] {
  const last = draft.at(-1);
  if (last && last.kind === kind) {
    return [...draft.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...draft, { kind, text }];
}

function requireDraft(state: SessionState, ev: string): readonly Block[] {
  if (state.draft === null) throw new Error(`${ev} before msg_start`);
  return state.draft;
}

export function reduce(state: SessionState, ev: ReducerEvent): SessionState {
  switch (ev.t) {
    case 'turn_start':
      return replaceState(state, { turn: state.turn + 1 });

    case 'user_msg':
      return replaceState(state, {
        history: [...state.history, { role: 'user', blocks: ev.blocks }],
      });

    case 'msg_start':
      return replaceState(state, { draft: [] });

    case 'text_delta':
      return replaceState(state, { draft: appendDelta(requireDraft(state, 'text_delta'), 'text', ev.text) });

    case 'thinking_delta':
      return replaceState(state, {
        draft: appendDelta(requireDraft(state, 'thinking_delta'), 'thinking', ev.text),
      });

    case 'tool_call': {
      const draft = requireDraft(state, 'tool_call');
      const call: PendingCall = { callId: ev.callId, name: ev.name, input: ev.input };
      return replaceState(state, {
        draft: [...draft, { kind: 'tool_call', callId: ev.callId, name: ev.name, input: ev.input }],
        pendingCalls: [...state.pendingCalls, call],
      });
    }

    case 'msg_end': {
      const draft = requireDraft(state, 'msg_end');
      return replaceState(state, {
        history: [...state.history, { role: 'assistant', blocks: draft }],
        draft: null,
        usage: addUsage(state.usage, ev.usage),
        lastStop: ev.stop,
      });
    }

    case 'tool_results': {
      const pending = new Map(state.pendingCalls.map((c) => [c.callId, c]));
      for (const r of ev.results) {
        if (!pending.delete(r.callId)) throw new Error(`tool_result for unknown callId: ${r.callId}`);
      }
      const blocks: Block[] = ev.results.map((r) => ({
        kind: 'tool_result',
        callId: r.callId,
        ok: r.ok,
        content: r.content,
      }));
      return replaceState(state, {
        history: [...state.history, { role: 'user', blocks }],
        pendingCalls: state.pendingCalls.filter((c) => pending.has(c.callId)),
      });
    }
  }
}
