import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { newId, CROCKFORD32 } from '../../../src/lib/ids.ts';

describe('newId', () => {
  test('is 26 chars of Crockford base32', () => {
    const id = newId();
    assert.equal(id.length, 26);
    for (const ch of id) assert.ok(CROCKFORD32.includes(ch), `bad char ${ch}`);
  });

  test('ids generated in sequence are unique', () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    assert.equal(new Set(ids).size, ids.length);
  });

  test('ids are strictly monotonic even within the same millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => newId());
    for (let i = 1; i < ids.length; i++) {
      assert.ok((ids[i] as string) > (ids[i - 1] as string), `ids[${i}] not > previous`);
    }
  });

  test('lexicographic order matches time order across milliseconds', async () => {
    const a = newId();
    await new Promise((r) => setTimeout(r, 5));
    const b = newId();
    assert.ok(b > a);
  });

  test('time prefix decodes to a plausible recent timestamp', () => {
    const id = newId();
    let ms = 0;
    for (const ch of id.slice(0, 10)) ms = ms * 32 + CROCKFORD32.indexOf(ch);
    const now = Date.now();
    assert.ok(Math.abs(now - ms) < 60_000, `decoded ${ms} vs now ${now}`);
  });
});
