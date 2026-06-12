import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildAnthropicBody,
  AnthropicEventTranslator,
  AnthropicWire,
} from '../../../src/providers/wire/anthropic.ts';
import { canonicalJson } from '../../../src/lib/hash.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';
import type { NeutralRequest, ProviderEvent } from '../../../src/providers/types.ts';

const RICH_REQ: NeutralRequest = {
  model: 'claude-fable-5',
  system: ['You are Vegito.', 'Project rules here.'],
  messages: [
    {
      role: 'user',
      blocks: [
        { kind: 'text', text: 'Look at this.' },
        { kind: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
      ],
    },
    {
      role: 'assistant',
      blocks: [
        { kind: 'thinking', text: 'hmm', sig: 'sig1' },
        { kind: 'text', text: 'Reading it.' },
        { kind: 'tool_call', callId: 'tu_1', name: 'read', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      blocks: [{ kind: 'tool_result', callId: 'tu_1', ok: false, content: 'ENOENT' }],
    },
  ],
  tools: [
    { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
    { name: 'write', description: 'Write a file', inputSchema: { type: 'object' } },
  ],
  maxTokens: 4096,
  reasoning: 'medium',
};

// The golden fixture: byte-stable via canonicalJson comparison (P2 gate).
const GOLDEN_BODY = {
  model: 'claude-fable-5',
  // raised above the thinking budget (8192 + 1024) so the request is valid
  max_tokens: 9216,
  stream: true,
  thinking: { type: 'enabled', budget_tokens: 8192 },
  system: [
    { type: 'text', text: 'You are Vegito.' },
    { type: 'text', text: 'Project rules here.', cache_control: { type: 'ephemeral' } },
  ],
  tools: [
    { name: 'read', description: 'Read a file', input_schema: { type: 'object' } },
    {
      name: 'write',
      description: 'Write a file',
      input_schema: { type: 'object' },
      cache_control: { type: 'ephemeral' },
    },
  ],
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this.' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig1' },
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: 'a.ts' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: 'ENOENT',
          is_error: true,
          cache_control: { type: 'ephemeral' },
        },
      ],
    },
  ],
};

describe('buildAnthropicBody', () => {
  test('rich request matches the golden fixture byte-for-byte', () => {
    const body = buildAnthropicBody(RICH_REQ);
    assert.deepEqual(body, GOLDEN_BODY);
    assert.equal(canonicalJson(body), canonicalJson(GOLDEN_BODY));
  });

  test('minimal request omits system/tools/thinking and caches the last block', () => {
    const body = buildAnthropicBody({
      model: 'm',
      system: [],
      messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
      tools: [],
      maxTokens: 100,
    });
    assert.deepEqual(body, {
      model: 'm',
      max_tokens: 100,
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
        },
      ],
    });
  });

  test('thinking block without sig omits the signature field', () => {
    const body = buildAnthropicBody({
      model: 'm',
      system: [],
      messages: [{ role: 'assistant', blocks: [{ kind: 'thinking', text: 't' }, { kind: 'text', text: 'x' }] }],
      tools: [],
      maxTokens: 100,
    }) as { messages: { content: Record<string, unknown>[] }[] };
    assert.deepEqual(body.messages[0]?.content[0], { type: 'thinking', thinking: 't' });
  });
});

function pushAll(tr: AnthropicEventTranslator, frames: readonly { event: string; data: unknown }[]): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const f of frames) out.push(...tr.push({ event: f.event, data: JSON.stringify(f.data) }));
  return out;
}

describe('AnthropicEventTranslator', () => {
  test('translates a full streamed message with text, thinking, and a tool call', () => {
    const tr = new AnthropicEventTranslator();
    const events = pushAll(tr, [
      { event: 'ping', data: { type: 'ping' } },
      {
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            model: 'claude-fable-5',
            usage: { input_tokens: 100, cache_read_input_tokens: 80, cache_creation_input_tokens: 20 },
          },
        },
      },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'mull' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu_1', name: 'read' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
      { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } } },
      { event: 'message_stop', data: { type: 'message_stop' } },
    ]);
    assert.deepEqual(events, [
      { t: 'msg_start', model: 'claude-fable-5' },
      { t: 'thinking_delta', text: 'mull' },
      { t: 'text_delta', text: 'Hel' },
      { t: 'text_delta', text: 'lo' },
      { t: 'tool_call', callId: 'tu_1', name: 'read', input: { path: 'a.ts' } },
      { t: 'msg_end', stop: 'tool_use', usage: { in: 100, out: 42, cacheRead: 80, cacheWrite: 20 } },
    ]);
  });

  test('tool call with no input deltas parses as empty object', () => {
    const tr = new AnthropicEventTranslator();
    const events = pushAll(tr, [
      { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_2', name: 'list' } } },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    ]);
    assert.deepEqual(events, [{ t: 'tool_call', callId: 'tu_2', name: 'list', input: {} }]);
  });

  test('error events throw mapped ProviderHttpErrors', () => {
    const overloaded = new AnthropicEventTranslator();
    assert.throws(
      () => overloaded.push({ event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) }),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 529 && /Overloaded/.test(err.message),
    );
    const limited = new AnthropicEventTranslator();
    assert.throws(
      () => limited.push({ event: 'error', data: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }) }),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 429,
    );
  });

  test('malformed frame JSON throws a retryable 502', () => {
    const tr = new AnthropicEventTranslator();
    assert.throws(
      () => tr.push({ event: 'message_start', data: '{nope' }),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 502 && err.shouldRetry === true,
    );
  });
});

function sseBody(frames: readonly { event: string; data: unknown }[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('');
}

describe('AnthropicWire', () => {
  const HAPPY_FRAMES = [
    { event: 'message_start', data: { type: 'message_start', message: { model: 'claude-fable-5', usage: { input_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];

  const REQ: NeutralRequest = {
    model: 'claude-fable-5',
    system: [],
    messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 100,
  };

  test('send posts the built body with auth headers and streams translated events', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(sseBody(HAPPY_FRAMES), { status: 200 });
    };
    const wire = new AnthropicWire({ auth: () => ({ 'x-api-key': 'k-test' }), fetchFn });
    const events: ProviderEvent[] = [];
    for await (const ev of wire.send(REQ, new AbortController().signal)) events.push(ev);

    assert.deepEqual(events, [
      { t: 'msg_start', model: 'claude-fable-5' },
      { t: 'text_delta', text: 'ok' },
      { t: 'msg_end', stop: 'end_turn', usage: { in: 1, out: 2, cacheRead: 0, cacheWrite: 0 } },
    ]);
    assert.ok(captured !== null);
    const got = captured as { url: string; init: RequestInit };
    assert.equal(got.url, 'https://api.anthropic.com/v1/messages');
    const headers = got.init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'k-test');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['content-type'], 'application/json');
    const sent = JSON.parse(String(got.init.body)) as Record<string, unknown>;
    assert.equal(canonicalJson(sent), canonicalJson(buildAnthropicBody(REQ)));
  });

  test('non-2xx responses throw ProviderHttpError with parsed Retry-After', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limited' } }), {
        status: 429,
        headers: { 'retry-after': '2' },
      });
    const wire = new AnthropicWire({ auth: () => ({}), fetchFn });
    await assert.rejects(
      (async () => {
        for await (const _ of wire.send(REQ, new AbortController().signal)) void _;
      })(),
      (err: unknown) =>
        err instanceof ProviderHttpError && err.status === 429 && err.retryAfterMs === 2000 && /limited/.test(err.message),
    );
  });
});
