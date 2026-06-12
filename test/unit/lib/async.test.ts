import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { deferred, claimOnce, sequential, withTimeout, TimeoutError } from '../../../src/lib/async.ts';

describe('deferred', () => {
  test('resolve settles the promise with the value', async () => {
    const d = deferred<number>();
    assert.equal(d.settled, false);
    d.resolve(42);
    assert.equal(await d.promise, 42);
    assert.equal(d.settled, true);
  });

  test('reject settles the promise with the error', async () => {
    const d = deferred<number>();
    d.reject(new Error('nope'));
    await assert.rejects(d.promise, /nope/);
    assert.equal(d.settled, true);
  });

  test('second settle attempt is a no-op (first wins)', async () => {
    const d = deferred<string>();
    d.resolve('first');
    d.resolve('second');
    d.reject(new Error('third'));
    assert.equal(await d.promise, 'first');
  });
});

describe('claimOnce', () => {
  test('first call claims and runs the function', () => {
    let runs = 0;
    const claim = claimOnce((x: number) => {
      runs++;
      return x * 2;
    });
    const r = claim(21);
    assert.deepEqual(r, { claimed: true, value: 42 });
    assert.equal(runs, 1);
  });

  test('subsequent calls do not claim and do not run the function', () => {
    let runs = 0;
    const claim = claimOnce(() => {
      runs++;
    });
    claim();
    const second = claim();
    const third = claim();
    assert.deepEqual(second, { claimed: false });
    assert.deepEqual(third, { claimed: false });
    assert.equal(runs, 1);
  });

  test('claim is atomic under synchronous reentrancy', () => {
    const order: string[] = [];
    const claim = claimOnce((tag: string) => {
      // reenter while the first claim is still executing
      const inner = claim('inner');
      order.push(`ran:${tag}`, `inner-claimed:${inner.claimed}`);
    });
    const outer = claim('outer');
    assert.equal(outer.claimed, true);
    assert.deepEqual(order, ['ran:outer', 'inner-claimed:false']);
  });
});

describe('sequential', () => {
  test('runs tasks one at a time in submission order', async () => {
    const seq = sequential();
    const log: string[] = [];
    const gate = deferred<void>();
    const p1 = seq(async () => {
      log.push('a:start');
      await gate.promise;
      log.push('a:end');
      return 'a';
    });
    const p2 = seq(async () => {
      log.push('b:start');
      return 'b';
    });
    // b must not start while a is blocked
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(log, ['a:start']);
    gate.resolve();
    assert.deepEqual(await Promise.all([p1, p2]), ['a', 'b']);
    assert.deepEqual(log, ['a:start', 'a:end', 'b:start']);
  });

  test('a rejected task does not block later tasks', async () => {
    const seq = sequential();
    const p1 = seq(async () => {
      throw new Error('boom');
    });
    const p2 = seq(async () => 'ok');
    await assert.rejects(p1, /boom/);
    assert.equal(await p2, 'ok');
  });
});

describe('withTimeout', () => {
  test('resolves with the value when the promise is fast', async () => {
    assert.equal(await withTimeout(Promise.resolve('fast'), 1000, 'op'), 'fast');
  });

  test('rejects with TimeoutError naming the operation when slow', async () => {
    const never = new Promise<string>(() => {});
    await assert.rejects(withTimeout(never, 10, 'slow-op'), (err: unknown) => {
      assert.ok(err instanceof TimeoutError);
      assert.match((err as Error).message, /slow-op/);
      assert.match((err as Error).message, /10/);
      return true;
    });
  });

  test('propagates the underlying rejection when it loses no race', async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error('inner')), 1000), /inner/);
  });
});
