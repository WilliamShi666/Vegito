// Streaming plumbing shared by HTTP wires: an incremental SSE parser and a
// stall guard that converts silence into retryable 408s (DESIGN §5.3 —
// hung streams are failures to recover from, not things to wait out).

import { ProviderHttpError } from './errors.ts';

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  #buffer = '';
  #eventType = 'message';
  #dataLines: string[] = [];

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    const out: SseEvent[] = [];
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) !== -1) {
      let line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const ev = this.#consumeLine(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  #consumeLine(line: string): SseEvent | null {
    if (line === '') {
      // blank line dispatches the buffered event
      const ev =
        this.#dataLines.length > 0 ? { event: this.#eventType, data: this.#dataLines.join('\n') } : null;
      this.#eventType = 'message';
      this.#dataLines = [];
      return ev;
    }
    if (line.startsWith(':')) return null; // comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.#eventType = value;
    else if (field === 'data') this.#dataLines.push(value);
    // id/retry/unknown fields: ignored
    return null;
  }
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export interface StallOpts {
  firstTokenMs: number;
  idleMs: number;
  timers?: Timers;
}

export async function* withStallGuard<T>(source: AsyncIterable<T>, opts: StallOpts): AsyncGenerator<T> {
  const timers = opts.timers ?? REAL_TIMERS;
  const it = source[Symbol.asyncIterator]();
  let first = true;
  try {
    for (;;) {
      const limitMs = first ? opts.firstTokenMs : opts.idleMs;
      const label = first ? 'first token' : 'idle';
      let handle: unknown;
      const stall = new Promise<never>((_, reject) => {
        handle = timers.setTimeout(
          () => reject(new ProviderHttpError(408, `stream stalled (${label}, ${limitMs}ms)`, { shouldRetry: true })),
          limitMs,
        );
      });
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([it.next(), stall]);
      } finally {
        timers.clearTimeout(handle);
      }
      if (result.done) return;
      first = false;
      yield result.value;
    }
  } finally {
    // Fire-and-forget: a source hung on a pending await would never settle
    // its return(); the guard must not deadlock its own failure path.
    void Promise.resolve(it.return?.()).catch(() => {});
  }
}
