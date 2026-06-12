// Vendor-neutral message algebra (DESIGN §5, D8). Every provider wire adapts
// to these shapes; the kernel, transcripts, and UIs never see raw API JSON.

export type Role = 'user' | 'assistant';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; sig?: string }
  | { kind: 'tool_call'; callId: string; name: string; input: unknown }
  | { kind: 'tool_result'; callId: string; ok: boolean; content: string }
  | { kind: 'image'; mediaType: string; dataBase64: string };

export interface NeutralMsg {
  role: Role;
  blocks: readonly Block[];
}

export interface Usage {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export const ZERO_USAGE: Usage = Object.freeze({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    in: a.in + b.in,
    out: a.out + b.out,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal';

// Streamed by a WireProtocol. tool_call arrives complete: wires buffer
// partial-JSON argument deltas internally and emit one finished call.
export type ProviderEvent =
  | { t: 'msg_start'; model: string }
  | { t: 'text_delta'; text: string }
  | { t: 'thinking_delta'; text: string }
  | { t: 'tool_call'; callId: string; name: string; input: unknown }
  | { t: 'msg_end'; stop: StopReason; usage: Usage };
