// Anthropic Messages wire (DESIGN §5.1): translates the neutral algebra to
// Messages-API shapes and streamed SSE back to ProviderEvents. Cache
// breakpoints (D4) land on the last tool, last system block, and the final
// block of the last message — a stable prefix the cache can actually hit.

import { ProviderHttpError } from '../errors.ts';
import { postSse } from '../http.ts';
import type { SseEvent } from '../stream.ts';
import type {
  Block,
  NeutralRequest,
  ProviderEvent,
  StopReason,
  Usage,
  WireProtocol,
} from '../types.ts';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const THINKING_BUDGETS = { low: 2048, medium: 8192, high: 24576 } as const;
// headroom so thinking + a real answer both fit under max_tokens
const THINKING_HEADROOM = 1024;

const CACHE_CONTROL = { type: 'ephemeral' } as const;

function withCache(block: Record<string, unknown>): Record<string, unknown> {
  return { ...block, cache_control: { ...CACHE_CONTROL } };
}

function blockToAnthropic(b: Block): Record<string, unknown> {
  switch (b.kind) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'thinking':
      return b.sig === undefined
        ? { type: 'thinking', thinking: b.text }
        : { type: 'thinking', thinking: b.text, signature: b.sig };
    case 'tool_call':
      return { type: 'tool_use', id: b.callId, name: b.name, input: b.input };
    case 'tool_result': {
      const base: Record<string, unknown> = { type: 'tool_result', tool_use_id: b.callId, content: b.content };
      return b.ok ? base : { ...base, is_error: true };
    }
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.dataBase64 } };
  }
}

export function buildAnthropicBody(req: NeutralRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens, stream: true };

  if (req.reasoning !== undefined && req.reasoning !== 'off') {
    const budget = THINKING_BUDGETS[req.reasoning];
    body['thinking'] = { type: 'enabled', budget_tokens: budget };
    body['max_tokens'] = Math.max(req.maxTokens, budget + THINKING_HEADROOM);
  }

  if (req.system.length > 0) {
    body['system'] = req.system.map((text, i) => {
      const block = { type: 'text', text };
      return i === req.system.length - 1 ? withCache(block) : block;
    });
  }

  if (req.tools.length > 0) {
    body['tools'] = req.tools.map((tool, i) => {
      const def = { name: tool.name, description: tool.description, input_schema: tool.inputSchema };
      return i === req.tools.length - 1 ? withCache(def) : def;
    });
  }

  body['messages'] = req.messages.map((msg, mi) => {
    const lastMsg = mi === req.messages.length - 1;
    return {
      role: msg.role,
      content: msg.blocks.map((b, bi) => {
        const converted = blockToAnthropic(b);
        return lastMsg && bi === msg.blocks.length - 1 ? withCache(converted) : converted;
      }),
    };
  });

  return body;
}

const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

function mapStop(reason: unknown): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

interface AnthropicFrame {
  type?: string;
  message?: { model?: string; usage?: Record<string, unknown> };
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class AnthropicEventTranslator {
  #toolBuffers = new Map<number, { id: string; name: string; json: string }>();
  #usage: Usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  #stop: StopReason = 'end_turn';

  push(ev: SseEvent): ProviderEvent[] {
    let frame: AnthropicFrame;
    try {
      frame = JSON.parse(ev.data) as AnthropicFrame;
    } catch (cause) {
      throw new ProviderHttpError(502, `anthropic: malformed SSE frame (${ev.event})`, { shouldRetry: true, cause });
    }
    switch (frame.type) {
      case 'message_start': {
        const usage = frame.message?.usage ?? {};
        this.#usage = {
          in: num(usage['input_tokens']),
          out: this.#usage.out,
          cacheRead: num(usage['cache_read_input_tokens']),
          cacheWrite: num(usage['cache_creation_input_tokens']),
        };
        return [{ t: 'msg_start', model: frame.message?.model ?? 'unknown' }];
      }
      case 'content_block_start': {
        const block = frame.content_block;
        if (block?.type === 'tool_use' && frame.index !== undefined) {
          this.#toolBuffers.set(frame.index, { id: block.id ?? '', name: block.name ?? '', json: '' });
        }
        return [];
      }
      case 'content_block_delta': {
        const delta = frame.delta;
        if (delta?.type === 'text_delta') return [{ t: 'text_delta', text: delta.text ?? '' }];
        if (delta?.type === 'thinking_delta') return [{ t: 'thinking_delta', text: delta.thinking ?? '' }];
        if (delta?.type === 'input_json_delta' && frame.index !== undefined) {
          const buf = this.#toolBuffers.get(frame.index);
          if (buf) this.#toolBuffers.set(frame.index, { ...buf, json: buf.json + (delta.partial_json ?? '') });
        }
        return []; // signature_delta and unknown deltas: ignored
      }
      case 'content_block_stop': {
        if (frame.index === undefined) return [];
        const buf = this.#toolBuffers.get(frame.index);
        if (!buf) return [];
        this.#toolBuffers.delete(frame.index);
        let input: unknown;
        try {
          input = buf.json === '' ? {} : JSON.parse(buf.json);
        } catch (cause) {
          throw new ProviderHttpError(502, `anthropic: unparseable tool input for ${buf.name}`, {
            shouldRetry: true,
            cause,
          });
        }
        return [{ t: 'tool_call', callId: buf.id, name: buf.name, input }];
      }
      case 'message_delta': {
        if (frame.delta?.stop_reason !== undefined) this.#stop = mapStop(frame.delta.stop_reason);
        const usage = frame.usage ?? {};
        if (usage['output_tokens'] !== undefined) this.#usage = { ...this.#usage, out: num(usage['output_tokens']) };
        return [];
      }
      case 'message_stop':
        return [{ t: 'msg_end', stop: this.#stop, usage: this.#usage }];
      case 'error': {
        const type = frame.error?.type ?? 'api_error';
        const status = ERROR_STATUS[type] ?? 500;
        throw new ProviderHttpError(status, `anthropic ${type}: ${frame.error?.message ?? ''}`);
      }
      default:
        return []; // ping and future event types
    }
  }
}

export interface AnthropicWireOpts {
  auth: () => Record<string, string>;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class AnthropicWire implements WireProtocol {
  readonly name = 'anthropic';
  #opts: AnthropicWireOpts;

  constructor(opts: AnthropicWireOpts) {
    this.#opts = opts;
  }

  send(req: NeutralRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    return this.#stream(req, signal);
  }

  async *#stream(req: NeutralRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const baseUrl = this.#opts.baseUrl ?? DEFAULT_BASE_URL;
    const translator = new AnthropicEventTranslator();
    const sse = postSse({
      url: `${baseUrl}/v1/messages`,
      headers: { 'anthropic-version': ANTHROPIC_VERSION, ...this.#opts.auth() },
      body: buildAnthropicBody(req),
      signal,
      provider: 'anthropic',
      ...(this.#opts.fetchFn === undefined ? {} : { fetchFn: this.#opts.fetchFn }),
    });
    for await (const frame of sse) yield* translator.push(frame);
  }
}
