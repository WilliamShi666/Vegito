// Integration: the recovery ladder (DESIGN §5.4) driven end-to-end through
// real modules — FailoverChain + CredentialPool + retry policy + stall guard
// — with ScriptedWire as the only fixture. No mocks of our own code.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { FailoverChain, type FailoverTarget } from '../../../src/providers/failover.ts';
import { CredentialPool, type Credential } from '../../../src/providers/credentials.ts';
import { ScriptedWire, scriptedText, type ScriptedStep } from '../../../src/providers/wire/scripted.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';
import type { ProviderEvent } from '../../../src/providers/types.ts';

const REQ = {
  model: 'requested-model',
  system: [],
  messages: [{ role: 'user' as const, blocks: [{ kind: 'text' as const, text: 'hi' }] }],
  tools: [],
  maxTokens: 100,
};

const POLICY = { maxAttempts: 4, baseMs: 10, capMs: 100 };

function cred(id: string): Credential {
  return { id, headers: { 'x-api-key': `key-${id}` } };
}

interface Harness {
  chain: FailoverChain;
  sleeps: number[];
  notices: string[];
}

function harness(targets: readonly FailoverTarget[], clock?: { now: () => number; advance: (ms: number) => void }): Harness {
  const sleeps: number[] = [];
  const notices: string[] = [];
  const chain = new FailoverChain({
    targets,
    retry: POLICY,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock?.advance(ms);
    },
    jitter: () => 1, // deterministic backoff: full raw delay
    notice: (text) => notices.push(text),
  });
  return { chain, sleeps, notices };
}

async function collect(chain: FailoverChain): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of chain.send(REQ, new AbortController().signal)) out.push(ev);
  return out;
}

describe('FailoverChain', () => {
  test('happy path: streams through, applies the target model, keeps the credential valid', async () => {
    const wire = new ScriptedWire([{ kind: 'events', events: scriptedText('ok') }]);
    const pool = new CredentialPool([cred('a')]);
    const { chain, notices } = harness([{ name: 'anthropic', model: 'target-model', wire, pool }]);

    const events = await collect(chain);
    assert.equal(events.length, 3);
    assert.deepEqual(events[1], { t: 'text_delta', text: 'ok' });
    assert.equal(wire.calls[0]?.model, 'target-model');
    assert.equal(pool.statuses()[0]?.state, 'valid');
    assert.deepEqual(notices, []);
  });

  test('401 rotates to the next credential in the same pool and succeeds', async () => {
    const wire = new ScriptedWire([
      { kind: 'error', error: new ProviderHttpError(401, 'bad key') },
      { kind: 'events', events: scriptedText('recovered') },
    ]);
    const pool = new CredentialPool([cred('a'), cred('b')]);
    const { chain, sleeps, notices } = harness([{ name: 'anthropic', model: 'm', wire, pool }]);

    const events = await collect(chain);
    assert.deepEqual(events[1], { t: 'text_delta', text: 'recovered' });
    assert.deepEqual(
      pool.statuses().map((s) => s.state),
      ['dead', 'valid'],
    );
    assert.deepEqual(sleeps, []); // rotation is immediate, no backoff
    assert.ok(notices.some((n) => /rotat/.test(n)));
  });

  test('GATE: 401 with no spare credential hops to the next target and succeeds', async () => {
    const wireA = new ScriptedWire([{ kind: 'error', error: new ProviderHttpError(401, 'revoked') }]);
    const wireB = new ScriptedWire([{ kind: 'events', events: scriptedText('from-b', { model: 'b-model' }) }]);
    const { chain, notices } = harness([
      { name: 'primary', model: 'model-a', wire: wireA, pool: new CredentialPool([cred('a')]) },
      { name: 'fallback', model: 'model-b', wire: wireB, pool: new CredentialPool([cred('b')]) },
    ]);

    const events = await collect(chain);
    assert.deepEqual(events[0], { t: 'msg_start', model: 'b-model' });
    assert.equal(wireA.calls.length, 1);
    assert.equal(wireB.calls.length, 1);
    assert.equal(wireB.calls[0]?.model, 'model-b');
    assert.ok(notices.some((n) => /failing over|hop/.test(n)));
  });

  test('429 honors retry-after for the sleep and recovers on the same target', async () => {
    let now = 0;
    const clock = { now: () => now, advance: (ms: number) => void (now += ms) };
    const wire = new ScriptedWire([
      { kind: 'error', error: new ProviderHttpError(429, 'limited', { retryAfterMs: 7 }) },
      { kind: 'events', events: scriptedText('after-cooldown') },
    ]);
    const pool = new CredentialPool([cred('a')], { now: clock.now });
    const { chain, sleeps } = harness([{ name: 'anthropic', model: 'm', wire, pool }], clock);

    const events = await collect(chain);
    assert.deepEqual(events[1], { t: 'text_delta', text: 'after-cooldown' });
    assert.deepEqual(sleeps, [7]); // server-stated wait, not exponential backoff
    assert.equal(pool.statuses()[0]?.state, 'valid'); // success restored it
  });

  test('a stalled stream converts to a retryable 408 and the retry succeeds', async () => {
    const wire = new ScriptedWire([
      { kind: 'stall', afterEvents: [] },
      { kind: 'events', events: scriptedText('unstuck') },
    ]);
    const pool = new CredentialPool([cred('a')]);
    const sleeps: number[] = [];
    const chain = new FailoverChain({
      targets: [{ name: 'anthropic', model: 'm', wire, pool }],
      retry: POLICY,
      stall: { firstTokenMs: 25, idleMs: 25 },
      sleep: async (ms) => void sleeps.push(ms),
      jitter: () => 1,
    });
    const events: ProviderEvent[] = [];
    for await (const ev of chain.send(REQ, new AbortController().signal)) events.push(ev);
    assert.equal(wire.calls.length, 2);
    assert.deepEqual(events.at(1), { t: 'text_delta', text: 'unstuck' });
    assert.equal(sleeps.length, 1);
  });

  test('non-retryable 400 surfaces immediately without hopping', async () => {
    const wireA = new ScriptedWire([{ kind: 'error', error: new ProviderHttpError(400, 'bad request') }]);
    const wireB = new ScriptedWire([{ kind: 'events', events: scriptedText('never') }]);
    const { chain } = harness([
      { name: 'primary', model: 'a', wire: wireA, pool: new CredentialPool([cred('a')]) },
      { name: 'fallback', model: 'b', wire: wireB, pool: new CredentialPool([cred('b')]) },
    ]);

    await assert.rejects(
      collect(chain),
      (err: unknown) => err instanceof ProviderHttpError && err.status === 400,
    );
    assert.equal(wireB.calls.length, 0);
  });

  test('exhausting retries on one target fails over; all targets failing throws 503', async () => {
    const always500 = (): ScriptedStep[] =>
      Array.from({ length: POLICY.maxAttempts }, () => ({
        kind: 'error' as const,
        error: new ProviderHttpError(500, 'down'),
      }));
    const wireA = new ScriptedWire(always500());
    const wireB = new ScriptedWire(always500());
    const { chain, sleeps, notices } = harness([
      { name: 'primary', model: 'a', wire: wireA, pool: new CredentialPool([cred('a')]) },
      { name: 'fallback', model: 'b', wire: wireB, pool: new CredentialPool([cred('b')]) },
    ]);

    await assert.rejects(
      collect(chain),
      (err: unknown) =>
        err instanceof ProviderHttpError &&
        err.status === 503 &&
        /primary/.test(err.message) &&
        /fallback/.test(err.message),
    );
    assert.equal(wireA.calls.length, POLICY.maxAttempts);
    assert.equal(wireB.calls.length, POLICY.maxAttempts);
    // 3 backoff sleeps per target at jitter()=1: 10, 20, 40
    assert.deepEqual(sleeps, [10, 20, 40, 10, 20, 40]);
    assert.ok(notices.some((n) => /failing over/.test(n)));
  });

  test('a pool with no usable credential skips straight to the next target', async () => {
    const wireA = new ScriptedWire([]);
    const wireB = new ScriptedWire([{ kind: 'events', events: scriptedText('b') }]);
    const { chain, notices } = harness([
      { name: 'primary', model: 'a', wire: wireA, pool: new CredentialPool([]) },
      { name: 'fallback', model: 'b', wire: wireB, pool: new CredentialPool([cred('b')]) },
    ]);

    const events = await collect(chain);
    assert.deepEqual(events[1], { t: 'text_delta', text: 'b' });
    assert.equal(wireA.calls.length, 0);
    assert.ok(notices.some((n) => /no usable credential/.test(n)));
  });
});
