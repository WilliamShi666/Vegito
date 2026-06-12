import { test, describe, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { truncateMiddle, MessageBudget, SpillStore, DEFAULT_BUDGET } from '../../../src/tools/budget.ts';

describe('truncateMiddle', () => {
  test('under cap: untouched', () => {
    const r = truncateMiddle('hello', 100);
    assert.equal(r.content, 'hello');
    assert.equal(r.truncated, false);
    assert.equal(r.omittedChars, 0);
  });

  test('exactly at cap: untouched (boundary)', () => {
    const text = 'x'.repeat(100);
    const r = truncateMiddle(text, 100);
    assert.equal(r.content, text);
    assert.equal(r.truncated, false);
  });

  test('one over cap: truncated, result fits the cap', () => {
    const text = 'h'.repeat(60) + 't'.repeat(41); // 101 chars
    const r = truncateMiddle(text, 100);
    assert.equal(r.truncated, true);
    assert.ok(r.content.length <= 100, `length ${r.content.length} > cap`);
    assert.ok(r.content.startsWith('h'));
    assert.ok(r.content.endsWith('t'));
    assert.ok(r.omittedChars > 0);
    assert.ok(r.content.includes(String(r.omittedChars)), 'marker states the omitted count');
  });

  test('keeps head AND tail; the middle is gone', () => {
    const text = 'A'.repeat(500) + 'M'.repeat(500) + 'Z'.repeat(500);
    const r = truncateMiddle(text, 200);
    assert.ok(r.content.startsWith('AAA'));
    assert.ok(r.content.endsWith('ZZZ'));
    assert.ok(!r.content.includes('M'), 'middle content must be elided');
    // omitted = original minus kept payload (everything in content that is A or Z)
    assert.equal(r.omittedChars, text.length - countAZ(r.content));
  });

  test('read-back pointer appears in the marker', () => {
    const r = truncateMiddle('x'.repeat(300), 120, '/tmp/outputs/call_1.txt');
    assert.equal(r.truncated, true);
    assert.ok(r.content.includes('/tmp/outputs/call_1.txt'));
  });

  test('pathological tiny cap still respects the cap', () => {
    const r = truncateMiddle('y'.repeat(1000), 10);
    assert.ok(r.content.length <= 10);
    assert.equal(r.truncated, true);
  });
});

function countAZ(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === 'A' || ch === 'Z') n += 1;
  return n;
}

describe('MessageBudget', () => {
  test('per-tool cap applies even with message budget to spare', async () => {
    const mb = new MessageBudget({ perToolChars: 50, perMessageChars: 1000, minFitChars: 10 });
    const r = await mb.fit('c1', 'x'.repeat(80));
    assert.equal(r.truncated, true);
    assert.ok(r.content.length <= 50);
  });

  test('aggregate squeeze: later outputs get only what remains of the message budget', async () => {
    const mb = new MessageBudget({ perToolChars: 100, perMessageChars: 150, minFitChars: 10 });
    const a = await mb.fit('c1', 'a'.repeat(90)); // fits whole: 90 ≤ min(100, 150)
    assert.equal(a.truncated, false);
    const b = await mb.fit('c2', 'b'.repeat(90)); // remaining 60 < 90 → squeezed
    assert.equal(b.truncated, true);
    assert.ok(b.content.length <= 60, `expected ≤60, got ${b.content.length}`);
  });

  test('floor: an exhausted message budget still yields at least minFitChars-capped marker', async () => {
    const mb = new MessageBudget({ perToolChars: 100, perMessageChars: 100, minFitChars: 10 });
    await mb.fit('c1', 'a'.repeat(100)); // consumes the whole message budget
    const r = await mb.fit('c2', 'b'.repeat(100));
    assert.equal(r.truncated, true);
    assert.ok(r.content.length <= 10);
    assert.ok(r.content.length > 0, 'a tool result is never silently emptied');
  });

  test('untruncated outputs charge the ledger by their actual size', async () => {
    const mb = new MessageBudget({ perToolChars: 100, perMessageChars: 100, minFitChars: 10 });
    const a = await mb.fit('c1', 'a'.repeat(30));
    const b = await mb.fit('c2', 'b'.repeat(30));
    assert.equal(a.truncated, false);
    assert.equal(b.truncated, false);
    const c = await mb.fit('c3', 'c'.repeat(60)); // remaining 40 < 60 → squeezed
    assert.equal(c.truncated, true);
    assert.ok(c.content.length <= 40);
  });

  test('DEFAULT_BUDGET is frozen and sane', () => {
    assert.ok(Object.isFrozen(DEFAULT_BUDGET));
    assert.ok(DEFAULT_BUDGET.perToolChars > 0);
    assert.ok(DEFAULT_BUDGET.perMessageChars >= DEFAULT_BUDGET.perToolChars);
  });
});

describe('SpillStore + MessageBudget integration', () => {
  const dirs: string[] = [];
  after(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), 'vegito-budget-'));
    dirs.push(d);
    return d;
  };

  test('spill writes the FULL original and the marker carries the pointer', async () => {
    const dir = await tmp();
    const mb = new MessageBudget({ perToolChars: 100, perMessageChars: 1000, minFitChars: 10 }, new SpillStore(dir));
    const full = 'S'.repeat(400);
    const r = await mb.fit('call_9', full);
    assert.equal(r.truncated, true);
    assert.ok(r.spillPath !== undefined);
    assert.ok(r.content.includes(r.spillPath as string), 'pointer must be in the visible content');
    assert.equal(await readFile(r.spillPath as string, 'utf8'), full);
  });

  test('untruncated outputs do not spill', async () => {
    const dir = await tmp();
    const mb = new MessageBudget({ perToolChars: 100, perMessageChars: 1000, minFitChars: 10 }, new SpillStore(dir));
    const r = await mb.fit('call_10', 'tiny');
    assert.equal(r.spillPath, undefined);
  });

  test('spill creates nested dirs and sanitizes hostile call ids', async () => {
    const dir = join(await tmp(), 'nested', 'outputs');
    const store = new SpillStore(dir);
    const p = await store.spill('../../etc/passwd', 'data');
    assert.ok(p.startsWith(dir), `spill escaped its dir: ${p}`);
    assert.equal(await readFile(p, 'utf8'), 'data');
  });
});
