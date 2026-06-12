// Shared HTTP plumbing for streaming wires: one POST-and-parse-SSE path so
// error mapping and Retry-After handling cannot drift between vendors.

import { ProviderHttpError } from './errors.ts';
import { SseParser, type SseEvent } from './stream.ts';

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

export interface PostSseOpts {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal;
  provider: string;
  fetchFn?: typeof fetch;
}

export async function* postSse(opts: PostSseOpts): AsyncGenerator<SseEvent> {
  const fetchFn = opts.fetchFn ?? fetch;
  const res = await fetchFn(opts.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: JSON.stringify(opts.body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    throw new ProviderHttpError(
      res.status,
      `${opts.provider} ${res.status}: ${text.slice(0, 300)}`,
      retryAfterMs === undefined ? undefined : { retryAfterMs },
    );
  }
  if (res.body === null) {
    throw new ProviderHttpError(502, `${opts.provider}: empty response body`, { shouldRetry: true });
  }
  const parser = new SseParser();
  const decoder = new TextDecoder();
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    yield* parser.push(decoder.decode(chunk, { stream: true }));
  }
}
