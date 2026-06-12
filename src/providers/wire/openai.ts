// OpenAI-compatible Chat Completions wire (DESIGN §5.1, D8): the same
// neutral algebra, translated for OpenAI and the long tail of compatible
// servers (ollama, vllm, openrouter, deepseek). Thinking blocks have no
// wire representation here and are dropped on send; reasoning_content
// deltas from compat servers surface as thinking_delta on receive.

import { ProviderHttpError } from '../errors.ts';
import { postSse } from '../http.ts';
import type { SseEvent } from '../stream.ts';
import type {
  Block,
  NeutralMsg,
  NeutralRequest,
  ProviderEvent,
  StopReason,
  Usage,
  WireProtocol,
} from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

type OpenAiMessage = Record<string, unknown>;

function userContent(blocks: readonly Block[]): unknown {
  const parts = blocks
    .filter((b): b is Extract<Block, { kind: 'text' | 'image' }> => b.kind === 'text' || b.kind === 'image')
    .map((b) =>
      b.kind === 'text'
        ? { type: 'text', text: b.text }
        : { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.dataBase64}` } },
    );
  if (parts.length === 1 && parts[0]?.type === 'text') {
    return (parts[0] as { text: string }).text;
  }
  return parts;
}

function msgToOpenAi(msg: NeutralMsg): OpenAiMessage[] {
  if (msg.role === 'user') {
    const out: OpenAiMessage[] = [];
    // tool results become standalone role:'tool' messages, in block order
    for (const b of msg.blocks) {
      if (b.kind === 'tool_result') out.push({ role: 'tool', tool_call_id: b.callId, content: b.content });
    }
    const rest = msg.blocks.filter((b) => b.kind === 'text' || b.kind === 'image');
    if (rest.length > 0) out.push({ role: 'user', content: userContent(rest) });
    return out;
  }
  // assistant: text joins to content, tool_calls accumulate, thinking drops
  const text = msg.blocks
    .filter((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = msg.blocks
    .filter((b): b is Extract<Block, { kind: 'tool_call' }> => b.kind === 'tool_call')
    .map((b) => ({ id: b.callId, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }));
  const out: OpenAiMessage = { role: 'assistant', content: text === '' ? null : text };
  if (toolCalls.length > 0) out['tool_calls'] = toolCalls;
  return [out];
}

export function buildOpenAiBody(req: NeutralRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (req.reasoning !== undefined && req.reasoning !== 'off') body['reasoning_effort'] = req.reasoning;
  if (req.tools.length > 0) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  const messages: OpenAiMessage[] = [];
  if (req.system.length > 0) messages.push({ role: 'system', content: req.system.join('\n\n') });
  for (const msg of req.messages) messages.push(...msgToOpenAi(msg));
  body['messages'] = messages;
  return body;
}

function mapFinish(reason: unknown): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

interface OpenAiChunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  error?: { message?: string; code?: unknown };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class OpenAiEventTranslator {
  #started = false;
  #toolBuffers = new Map<number, { id: string; name: string; args: string }>();
  #usage: Usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  #stop: StopReason = 'end_turn';

  push(ev: SseEvent): ProviderEvent[] {
    if (ev.data.trim() === '[DONE]') return [...this.#flushToolCalls(), { t: 'msg_end', stop: this.#stop, usage: this.#usage }];
    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(ev.data) as OpenAiChunk;
    } catch (cause) {
      throw new ProviderHttpError(502, 'openai: malformed SSE frame', { shouldRetry: true, cause });
    }
    if (chunk.error !== undefined) {
      throw new ProviderHttpError(500, `openai error: ${chunk.error.message ?? 'unknown'}`);
    }
    const out: ProviderEvent[] = [];
    if (!this.#started) {
      this.#started = true;
      out.push({ t: 'msg_start', model: chunk.model ?? 'unknown' });
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
      out.push({ t: 'thinking_delta', text: delta.reasoning_content });
    }
    if (typeof delta?.content === 'string' && delta.content !== '') {
      out.push({ t: 'text_delta', text: delta.content });
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = tc.index ?? 0;
      const prev = this.#toolBuffers.get(index) ?? { id: '', name: '', args: '' };
      this.#toolBuffers.set(index, {
        id: tc.id ?? prev.id,
        name: tc.function?.name ?? prev.name,
        args: prev.args + (tc.function?.arguments ?? ''),
      });
    }
    if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
      this.#stop = mapFinish(choice.finish_reason);
    }
    if (chunk.usage !== undefined && chunk.usage !== null) {
      this.#usage = {
        in: num(chunk.usage.prompt_tokens),
        out: num(chunk.usage.completion_tokens),
        cacheRead: num(chunk.usage.prompt_tokens_details?.cached_tokens),
        cacheWrite: 0,
      };
    }
    return out;
  }

  #flushToolCalls(): ProviderEvent[] {
    const out: ProviderEvent[] = [];
    const indices = [...this.#toolBuffers.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const buf = this.#toolBuffers.get(index);
      if (buf === undefined) continue;
      let input: unknown;
      try {
        input = buf.args === '' ? {} : JSON.parse(buf.args);
      } catch (cause) {
        throw new ProviderHttpError(502, `openai: unparseable tool arguments for ${buf.name}`, {
          shouldRetry: true,
          cause,
        });
      }
      out.push({ t: 'tool_call', callId: buf.id, name: buf.name, input });
    }
    this.#toolBuffers.clear();
    return out;
  }
}

export interface OpenAiWireOpts {
  auth: () => Record<string, string>;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export class OpenAiWire implements WireProtocol {
  readonly name = 'openai';
  #opts: OpenAiWireOpts;

  constructor(opts: OpenAiWireOpts) {
    this.#opts = opts;
  }

  send(req: NeutralRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    return this.#stream(req, signal);
  }

  async *#stream(req: NeutralRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    const baseUrl = this.#opts.baseUrl ?? DEFAULT_BASE_URL;
    const translator = new OpenAiEventTranslator();
    const sse = postSse({
      url: `${baseUrl}/chat/completions`,
      headers: this.#opts.auth(),
      body: buildOpenAiBody(req),
      signal,
      provider: 'openai',
      ...(this.#opts.fetchFn === undefined ? {} : { fetchFn: this.#opts.fetchFn }),
    });
    for await (const frame of sse) yield* translator.push(frame);
  }
}
