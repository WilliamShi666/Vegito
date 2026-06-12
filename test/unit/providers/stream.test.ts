import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { SseParser, withStallGuard, type Timers } from '../../../src/providers/stream.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';

describe('SseParser', () => {
  test('parses a complete event and defaults type to "message"', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: hello\n\n'), [{ event: 'message', data: 'hello' }]);
  });

  test('buffers partial chunks until the blank-line terminator', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: {"a":'), []);
    assert.deepEqual(p.push('1}\n'), []);
    assert.deepEqual(p.push('\n'), [{ event: 'message', data: '{"a":1}' }]);
  });

  test('captures event: type and joins multi-line data with newlines', () => {
    const p = new SseParser();
    const events = p.push('event: content_block_delta\ndata: line1\ndata: line2\n\n');
    assert.deepEqual(events, [{ event: 'content_block_delta', data: 'line1\nline2' }]);
  });

  test('handles CRLF, comments, and multiple events per chunk', () => {
    const p = new SseParser();
    const events = p.push(': keepalive\r\ndata: one\r\n\r\nevent: ping\r\ndata: two\r\n\r\n');
    assert.deepEqual(events, [
      { event: 'message', data: 'one' },
      { event: 'ping', data: 'two' },
    ]);
  });

  test('strips exactly one leading space from field values', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data:  spaced\n\n'), [{ event: 'message', data: ' spaced' }]);
    assert.deepEqual(p.push('data:tight\n\n'), [{ event: 'message', data: 'tight' }]);
  });

  test('an event with no data lines produces nothing', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('event: ping\n\n'), []);
  });
});

class FakeTimers implements Timers {
  registered: { fn: () => void; ms: number; cleared: boolean }[] = [];

  setTimeout(fn: () => void, ms: number): unknown {
    this.registered.push({ fn, ms, cleared: false });
    return this.registered.length - 1;
  }

  clearTimeout(handle: unknown): void {
    const entry = this.registered[handle as number];
    if (entry) entry.cleared = true;
  }

  fire(i: number): void {
    const entry = this.registered[i];
    if (!entry || entry.cleared) throw new Error(`timer ${i} not firable`);
    entry.fn();
  }
}

async function* lively<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function* hangAfter<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
  await new Promise(() => {}); // never settles
}

describe('withStallGuard', () => {
  test('passes a lively stream through untouched and clears every timer', async () => {
    const timers = new FakeTimers();
    const out: number[] = [];
    for await (const v of withStallGuard(lively([1, 2, 3]), { firstTokenMs: 1000, idleMs: 500, timers })) {
      out.push(v);
    }
    assert.deepEqual(out, [1, 2, 3]);
    assert.ok(timers.registered.length > 0);
    assert.ok(timers.registered.every((t) => t.cleared));
  });

  test('first-token stall throws a retryable 408', async () => {
    const timers = new FakeTimers();
    const iter = withStallGuard(hangAfter<number>([]), { firstTokenMs: 1000, idleMs: 500, timers });
    const run = (async () => {
      for await (const _ of iter) void _;
    })();
    // only the first-token timer exists; firing it must reject the iteration
    assert.equal(timers.registered[0]?.ms, 1000);
    timers.fire(0);
    await assert.rejects(
      run,
      (err: unknown) =>
        err instanceof ProviderHttpError && err.status === 408 && /first token/.test(err.message) && err.shouldRetry === true,
    );
  });

  test('idle stall after the first event throws a retryable 408', async () => {
    const timers = new FakeTimers();
    const seen: number[] = [];
    const run = (async () => {
      for await (const v of withStallGuard(hangAfter([42]), { firstTokenMs: 1000, idleMs: 500, timers })) {
        seen.push(v);
      }
    })();
    // wait until the idle timer (500ms) is registered after the first item
    while (!timers.registered.some((t) => t.ms === 500 && !t.cleared)) {
      await new Promise((r) => setImmediate(r));
    }
    assert.deepEqual(seen, [42]);
    timers.fire(timers.registered.findIndex((t) => t.ms === 500 && !t.cleared));
    await assert.rejects(
      run,
      (err: unknown) => err instanceof ProviderHttpError && err.status === 408 && /idle/.test(err.message),
    );
  });
});
