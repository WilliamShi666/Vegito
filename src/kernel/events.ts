// The kernel's public event stream (DESIGN §3.1). One JSON-serializable
// stream drives every UI surface (D11) and the trace log alike.

import type { Usage } from '../providers/types.ts';

export const EXIT_REASONS = [
  'end_turn',
  'max_iterations',
  'budget_tokens',
  'interrupted',
  'denial_breaker',
  'fatal_error',
  'awaiting_input',
] as const;

export type ExitReason = (typeof EXIT_REASONS)[number];

export interface AskOption {
  id: string;
  label: string;
}

// Everything the loop can ask a human, declaratively — UIs render it,
// permissions/tools never talk to a terminal themselves.
export type AskSpec =
  | { kind: 'permission'; title: string; detail?: string; options: readonly AskOption[] }
  | { kind: 'input'; title: string; placeholder?: string };

// Tool-provided display hint. `kind` is an open vocabulary ('text', 'diff',
// 'table', …); UIs fall back to plain text for kinds they don't know.
export interface ToolUIData {
  kind: string;
  data?: unknown;
}

export type LoopEvent =
  | { t: 'turn_start'; turn: number }
  | { t: 'model_call'; provider: string; model: string; attempt: number }
  | { t: 'text_delta'; text: string }
  | { t: 'thinking_delta'; text: string }
  | { t: 'tool_start'; callId: string; name: string; input: unknown }
  | { t: 'tool_end'; callId: string; ok: boolean; ui?: ToolUIData }
  | { t: 'ask'; askId: string; spec: AskSpec }
  | { t: 'context'; used: number; budget: number }
  | { t: 'compaction'; kind: 'micro' | 'full' }
  | { t: 'notice'; level: 'info' | 'warn'; text: string }
  | { t: 'turn_end'; reason: ExitReason; usage: Usage };
