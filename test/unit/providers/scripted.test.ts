import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { ScriptedWire, scriptedText } from '../../../src/providers/wire/scripted.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';
import type { NeutralRequest, ProviderEvent } from '../../../src/providers/types.ts';

const req = (text: string): NeutralRequest => ({
  model: 'scripted-1',
  system: ['You are Vegito.'],
  messages: [{ role: 'user', blocks: [{ kind: 'text', text }] }],
  tools: [],
  maxTokens: 1000,
});

async function collect(iter: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

describe('ScriptedWire', () => {
  test('plays back scripted event steps in order, one per send()', async () => {
    const wire = new ScriptedWire([
      { kind: 'events', events: scriptedText('first') },
      { kind: 'events', events: scriptedText('second') },
    ]);
    const a = await collect(wire.send(req('one'), new AbortController().signal));
    const b = await collect(wire.send(req('two'), new AbortController().signal));
    assert.deepEqual(a[0], { t: 'msg_start', model: 'scripted-1' });
    assert.deepEqual(a[1], { t: 'text_delta', text: 'first' });
    assert.equal(a.at(-1)?.t, 'msg_end');
    assert.deepEqual(b[1], { t: 'text_delta', text: 'second' });
  });

  test('records every request for assertions', async () => {
    const wire = new ScriptedWire([{ kind: 'events', events: scriptedText('ok') }]);
    await collect(wire.send(req('hello'), new AbortController().signal));
    assert.equal(wire.calls.length, 1);
    assert.deepEqual(wire.calls[0]?.messages[0]?.blocks, [{ kind: 'text', text: 'hello' }]);
  });

  test('an error step throws its ProviderHttpError before any event', async () => {
    const wire = new ScriptedWire([
      { kind: 'error', error: new ProviderHttpError(429, 'rate limited', { retryAfterMs: 1200 }) },
      { kind: 'events', events: scriptedText('after recovery') },
    ]);
    await assert.rejects(
      collect(wire.send(req('x'), new AbortController().signal)),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 429 && err.retryAfterMs === 1200,
    );
    // the script advances past the error: next call succeeds
    const ok = await collect(wire.send(req('x'), new AbortController().signal));
    assert.deepEqual(ok[1], { t: 'text_delta', text: 'after recovery' });
  });

  test('a stall step emits its prefix then hangs until aborted', async () => {
    const wire = new ScriptedWire([
      { kind: 'stall', afterEvents: [{ t: 'msg_start', model: 'scripted-1' }, { t: 'text_delta', text: 'par' }] },
    ]);
    const ctrl = new AbortController();
    const seen: ProviderEvent[] = [];
    const run = (async () => {
      for await (const ev of wire.send(req('x'), ctrl.signal)) {
        seen.push(ev);
        if (seen.length === 2) ctrl.abort();
      }
    })();
    await assert.rejects(run, (err: unknown) => (err as Error).name === 'AbortError');
    assert.deepEqual(seen.map((e) => e.t), ['msg_start', 'text_delta']);
  });

  test('an exhausted script refuses further calls loudly', async () => {
    const wire = new ScriptedWire([]);
    await assert.rejects(collect(wire.send(req('x'), new AbortController().signal)), /script exhausted/);
  });
});

describe('scriptedText helper', () => {
  test('builds msg_start / text_delta / msg_end with usage', () => {
    const events = scriptedText('hi', { usage: { in: 5, out: 2, cacheRead: 0, cacheWrite: 0 } });
    assert.deepEqual(events, [
      { t: 'msg_start', model: 'scripted-1' },
      { t: 'text_delta', text: 'hi' },
      { t: 'msg_end', stop: 'end_turn', usage: { in: 5, out: 2, cacheRead: 0, cacheWrite: 0 } },
    ]);
  });
});
