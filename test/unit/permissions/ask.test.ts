import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { createDeferred, createAskBroker } from '../../../src/permissions/ask.ts';
import type { AskSpec } from '../../../src/kernel/events.ts';

describe('createDeferred', () => {
  test('resolves with the supplied value', async () => {
    const d = createDeferred<number>();
    d.resolve(42);
    assert.equal(await d.promise, 42);
  });

  test('claimOnce: the first claim wins, later claims are no-ops', () => {
    const d = createDeferred<string>();
    assert.equal(d.claimOnce(), true);
    assert.equal(d.claimOnce(), false);
    assert.equal(d.claimOnce(), false);
  });

  test('resolve is idempotent — a second resolve does not change the value', async () => {
    const d = createDeferred<string>();
    d.resolve('first');
    d.resolve('second');
    assert.equal(await d.promise, 'first');
  });

  test('the canonical race: only the winner resolves, even if both call resolve', async () => {
    const d = createDeferred<string>();
    const settle = (who: string): void => {
      if (d.claimOnce()) d.resolve(who);
    };
    settle('A');
    settle('B'); // loses the claim, must not overwrite
    assert.equal(await d.promise, 'A');
  });
});

describe('createAskBroker', () => {
  const permSpec: AskSpec = {
    kind: 'permission',
    title: 'Allow bash: rm -rf build?',
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
  };

  test('open() returns a unique askId, the spec, and a pending promise', () => {
    const broker = createAskBroker();
    const a = broker.open(permSpec);
    const b = broker.open(permSpec);
    assert.notEqual(a.askId, b.askId);
    assert.equal(a.spec, permSpec);
    assert.ok(a.promise instanceof Promise);
  });

  test('settle(askId, value) resolves the matching pending ask', async () => {
    const broker = createAskBroker();
    const { askId, promise } = broker.open(permSpec);
    const settled = broker.settle(askId, 'allow');
    assert.equal(settled, true);
    assert.equal(await promise, 'allow');
  });

  test('settle on an unknown askId returns false', () => {
    const broker = createAskBroker();
    assert.equal(broker.settle('nope', 'allow'), false);
  });

  test('a second settle on the same askId returns false (claimed once)', async () => {
    const broker = createAskBroker();
    const { askId, promise } = broker.open(permSpec);
    assert.equal(broker.settle(askId, 'allow'), true);
    assert.equal(broker.settle(askId, 'deny'), false);
    assert.equal(await promise, 'allow');
  });

  test('settling removes the ask: it is no longer pending', () => {
    const broker = createAskBroker();
    const { askId } = broker.open(permSpec);
    assert.equal(broker.pending().length, 1);
    broker.settle(askId, 'allow');
    assert.equal(broker.pending().length, 0);
  });

  test('pending() lists open asks with their ids and specs', () => {
    const broker = createAskBroker();
    const { askId } = broker.open(permSpec);
    const list = broker.pending();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.askId, askId);
    assert.equal(list[0]?.spec, permSpec);
  });

  test('rejectAll settles every pending ask with the fallback value', async () => {
    const broker = createAskBroker();
    const a = broker.open(permSpec);
    const b = broker.open(permSpec);
    broker.rejectAll('deny');
    assert.equal(await a.promise, 'deny');
    assert.equal(await b.promise, 'deny');
    assert.equal(broker.pending().length, 0);
  });
});
