import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildOpenAiBody, OpenAiEventTranslator, OpenAiWire } from '../../../src/providers/wire/openai.ts';
import { canonicalJson } from '../../../src/lib/hash.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';
import type { NeutralRequest, ProviderEvent } from '../../../src/providers/types.ts';

const RICH_REQ: NeutralRequest = {
  model: 'gpt-x',
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

// Golden fixture (P2 gate): byte-stable via canonicalJson comparison.
const GOLDEN_BODY = {
  model: 'gpt-x',
  max_tokens: 4096,
  stream: true,
  stream_options: { include_usage: true },
  reasoning_effort: 'medium',
  tools: [
    { type: 'function', function: { name: 'read', description: 'Read a file', parameters: { type: 'object' } } },
    { type: 'function', function: { name: 'write', description: 'Write a file', parameters: { type: 'object' } } },
  ],
  messages: [
    { role: 'system', content: 'You are Vegito.\n\nProject rules here.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    },
    {
      role: 'assistant',
      content: 'Reading it.',
      tool_calls: [{ id: 'tu_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }],
    },
    { role: 'tool', tool_call_id: 'tu_1', content: 'ENOENT' },
  ],
};

describe('buildOpenAiBody', () => {
  test('rich request matches the golden fixture byte-for-byte (thinking dropped)', () => {
    const body = buildOpenAiBody(RICH_REQ);
    assert.deepEqual(body, GOLDEN_BODY);
    assert.equal(canonicalJson(body), canonicalJson(GOLDEN_BODY));
  });

  test('minimal request: plain string content, no tools/system/reasoning fields', () => {
    const body = buildOpenAiBody({
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
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  test('tool-call-only assistant turn has null content', () => {
    const body = buildOpenAiBody({
      model: 'm',
      system: [],
      messages: [
        { role: 'assistant', blocks: [{ kind: 'tool_call', callId: 'c1', name: 'ls', input: {} }] },
      ],
      tools: [],
      maxTokens: 100,
    }) as { messages: Record<string, unknown>[] };
    assert.deepEqual(body.messages[0], {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
    });
  });
});

function pushAll(tr: OpenAiEventTranslator, datas: readonly string[]): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  for (const data of datas) out.push(...tr.push({ event: 'message', data }));
  return out;
}

describe('OpenAiEventTranslator', () => {
  test('translates a streamed completion with text and an accumulated tool call', () => {
    const tr = new OpenAiEventTranslator();
    const events = pushAll(tr, [
      JSON.stringify({ model: 'gpt-x', choices: [{ delta: { role: 'assistant', content: '' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'lo' } }] }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"pa' } }] } }],
      }),
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 42, prompt_tokens_details: { cached_tokens: 80 } },
      }),
      '[DONE]',
    ]);
    assert.deepEqual(events, [
      { t: 'msg_start', model: 'gpt-x' },
      { t: 'text_delta', text: 'Hel' },
      { t: 'text_delta', text: 'lo' },
      { t: 'tool_call', callId: 'call_1', name: 'read', input: { path: 'a.ts' } },
      { t: 'msg_end', stop: 'tool_use', usage: { in: 100, out: 42, cacheRead: 80, cacheWrite: 0 } },
    ]);
  });

  test('reasoning_content deltas surface as thinking_delta', () => {
    const tr = new OpenAiEventTranslator();
    const events = pushAll(tr, [
      JSON.stringify({ model: 'r1', choices: [{ delta: { reasoning_content: 'mull' } }] }),
    ]);
    assert.deepEqual(events, [
      { t: 'msg_start', model: 'r1' },
      { t: 'thinking_delta', text: 'mull' },
    ]);
  });

  test('finish_reason length maps to max_tokens; missing usage stays zero', () => {
    const tr = new OpenAiEventTranslator();
    const events = pushAll(tr, [
      JSON.stringify({ model: 'm', choices: [{ delta: { content: 'x' }, finish_reason: 'length' }] }),
      '[DONE]',
    ]);
    assert.deepEqual(events.at(-1), {
      t: 'msg_end',
      stop: 'max_tokens',
      usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  test('inline error frames throw ProviderHttpError', () => {
    const tr = new OpenAiEventTranslator();
    assert.throws(
      () => tr.push({ event: 'message', data: JSON.stringify({ error: { message: 'boom', code: 'server_error' } }) }),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 500 && /boom/.test(err.message),
    );
  });

  test('malformed frame JSON throws a retryable 502', () => {
    const tr = new OpenAiEventTranslator();
    assert.throws(
      () => tr.push({ event: 'message', data: '{nope' }),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 502 && err.shouldRetry === true,
    );
  });
});

describe('OpenAiWire', () => {
  const REQ: NeutralRequest = {
    model: 'gpt-x',
    system: [],
    messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 100,
  };

  const SSE = [
    `data: ${JSON.stringify({ model: 'gpt-x', choices: [{ delta: { content: 'ok' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })}`,
    'data: [DONE]',
  ]
    .map((l) => `${l}\n\n`)
    .join('');

  test('send posts the built body with auth headers and streams translated events', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(SSE, { status: 200 });
    };
    const wire = new OpenAiWire({ auth: () => ({ authorization: 'Bearer k-test' }), fetchFn });
    const events: ProviderEvent[] = [];
    for await (const ev of wire.send(REQ, new AbortController().signal)) events.push(ev);

    assert.deepEqual(events, [
      { t: 'msg_start', model: 'gpt-x' },
      { t: 'text_delta', text: 'ok' },
      { t: 'msg_end', stop: 'end_turn', usage: { in: 1, out: 2, cacheRead: 0, cacheWrite: 0 } },
    ]);
    assert.ok(captured !== null);
    const got = captured as { url: string; init: RequestInit };
    assert.equal(got.url, 'https://api.openai.com/v1/chat/completions');
    const headers = got.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer k-test');
    assert.equal(headers['content-type'], 'application/json');
    const sent = JSON.parse(String(got.init.body)) as Record<string, unknown>;
    assert.equal(canonicalJson(sent), canonicalJson(buildOpenAiBody(REQ)));
  });

  test('a custom baseUrl points at compatible servers', async () => {
    let url = '';
    const fetchFn: typeof fetch = async (u) => {
      url = String(u);
      return new Response(SSE, { status: 200 });
    };
    const wire = new OpenAiWire({ auth: () => ({}), baseUrl: 'http://localhost:11434/v1', fetchFn });
    for await (const _ of wire.send(REQ, new AbortController().signal)) void _;
    assert.equal(url, 'http://localhost:11434/v1/chat/completions');
  });

  test('non-2xx responses throw ProviderHttpError with parsed Retry-After', async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'limited' } }), {
        status: 429,
        headers: { 'retry-after': '3' },
      });
    const wire = new OpenAiWire({ auth: () => ({}), fetchFn });
    await assert.rejects(
      (async () => {
        for await (const _ of wire.send(REQ, new AbortController().signal)) void _;
      })(),
      (err: unknown) =>
        err instanceof ProviderHttpError && err.status === 429 && err.retryAfterMs === 3000 && /limited/.test(err.message),
    );
  });
});
