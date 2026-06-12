import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { canonicalJson, canonicalHash } from '../../../src/lib/hash.ts';

// Seeded PRNG so property tests are reproducible (no Math.random).
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: readonly T[], rnd: () => number): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

function randomValue(rnd: () => number, depth: number): unknown {
  const pick = Math.floor(rnd() * (depth > 2 ? 4 : 6));
  switch (pick) {
    case 0: return Math.floor(rnd() * 1e6) - 5e5;
    case 1: return rnd().toFixed(6);
    case 2: return rnd() > 0.5;
    case 3: return null;
    case 4: return Array.from({ length: Math.floor(rnd() * 4) }, () => randomValue(rnd, depth + 1));
    default: {
      const obj: Record<string, unknown> = {};
      const n = Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) obj[`k${Math.floor(rnd() * 100)}`] = randomValue(rnd, depth + 1);
      return obj;
    }
  }
}

function reorderKeys(value: unknown, rnd: () => number): unknown {
  if (Array.isArray(value)) return value.map((v) => reorderKeys(v, rnd));
  if (value !== null && typeof value === 'object') {
    const entries = shuffled(Object.entries(value as Record<string, unknown>), rnd);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = reorderKeys(v, rnd);
    return out;
  }
  return value;
}

describe('canonicalJson', () => {
  test('sorts object keys', () => {
    assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  });

  test('key order does not change output (flat)', () => {
    assert.equal(canonicalJson({ a: 1, b: 2, c: 3 }), canonicalJson({ c: 3, b: 2, a: 1 }));
  });

  test('key order does not change output (nested)', () => {
    const x = { outer: { z: [{ b: 1, a: 2 }], a: 'v' }, list: [1, 2] };
    const y = { list: [1, 2], outer: { a: 'v', z: [{ a: 2, b: 1 }] } };
    assert.equal(canonicalJson(x), canonicalJson(y));
  });

  test('array order is significant', () => {
    assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  });

  test('drops undefined object properties like JSON.stringify', () => {
    assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  });

  test('NaN and Infinity encode as null (JSON semantics)', () => {
    assert.equal(canonicalJson({ a: NaN, b: Infinity }), '{"a":null,"b":null}');
  });

  test('output is valid JSON that round-trips', () => {
    const v = { u: 'héllo 世界', n: 1.5, arr: [true, null, { k: 'v' }] };
    assert.deepEqual(JSON.parse(canonicalJson(v)), v);
  });

  test('throws on circular structures', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    assert.throws(() => canonicalJson(a));
  });

  test('property: random nested values are key-order invariant (seeds 1..50)', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = mulberry32(seed);
      const value = randomValue(rnd, 0);
      const reordered = reorderKeys(value, mulberry32(seed + 1000));
      assert.equal(canonicalJson(value), canonicalJson(reordered), `seed ${seed}`);
    }
  });
});

describe('canonicalHash', () => {
  test('returns 64-char lowercase hex (sha-256)', () => {
    assert.match(canonicalHash({ a: 1 }), /^[0-9a-f]{64}$/);
  });

  test('equal for key-reordered objects', () => {
    assert.equal(canonicalHash({ a: 1, b: { d: 4, c: 3 } }), canonicalHash({ b: { c: 3, d: 4 }, a: 1 }));
  });

  test('distinct for distinct values, including type differences', () => {
    assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: '1' }));
    assert.notEqual(canonicalHash([]), canonicalHash({}));
    assert.notEqual(canonicalHash(null), canonicalHash('null'));
  });

  test('stable across calls', () => {
    const v = { msg: 'same input, same hash', n: 42 };
    assert.equal(canonicalHash(v), canonicalHash(v));
  });
});
