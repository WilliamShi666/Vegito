import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { RwGate } from '../../../src/tools/gate.ts';
import { deferred } from '../../../src/lib/async.ts';

describe('RwGate', () => {
  test('reads overlap: both running before either finishes', async () => {
    const gate = new RwGate();
    const hold = deferred<void>();
    let running = 0;
    let peak = 0;
    const reader = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await hold.promise;
      running -= 1;
    };
    const both = Promise.all([gate.run('read', reader), gate.run('read', reader)]);
    await Promise.resolve(); // let both acquire
    assert.equal(peak, 2); // truly concurrent
    hold.resolve();
    await both;
  });

  test('writes never overlap: second starts only after first releases', async () => {
    const gate = new RwGate();
    const log: string[] = [];
    const hold = deferred<void>();
    const w1 = gate.run('write', async () => {
      log.push('w1-start');
      await hold.promise;
      log.push('w1-end');
    });
    const w2 = gate.run('write', async () => {
      log.push('w2-start');
    });
    await Promise.resolve();
    assert.deepEqual(log, ['w1-start']); // w2 is parked
    hold.resolve();
    await Promise.all([w1, w2]);
    assert.deepEqual(log, ['w1-start', 'w1-end', 'w2-start']);
  });

  test('a write excludes reads, and a queued write is not starved by later reads', async () => {
    const gate = new RwGate();
    const log: string[] = [];
    const holdRead = deferred<void>();
    const r1 = gate.run('read', async () => {
      log.push('r1-start');
      await holdRead.promise;
      log.push('r1-end');
    });
    await Promise.resolve();
    const w = gate.run('write', async () => {
      log.push('w-start');
    });
    const r2 = gate.run('read', async () => {
      log.push('r2-start');
    });
    await Promise.resolve();
    // r1 holds the lock; w waits on r1; r2 must queue BEHIND w (fairness)
    assert.deepEqual(log, ['r1-start']);
    holdRead.resolve();
    await Promise.all([r1, w, r2]);
    assert.deepEqual(log, ['r1-start', 'r1-end', 'w-start', 'r2-start']);
  });

  test('a throwing task releases the lock for the next one', async () => {
    const gate = new RwGate();
    await assert.rejects(
      gate.run('write', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    const out = await gate.run('write', async () => 'after');
    assert.equal(out, 'after');
  });

  test('returns the task value', async () => {
    const gate = new RwGate();
    assert.equal(await gate.run('read', async () => 42), 42);
  });
});
