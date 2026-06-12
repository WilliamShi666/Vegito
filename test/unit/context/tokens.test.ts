import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { estimateTokens } from '../../../src/context/tokens.ts';

describe('estimateTokens', () => {
  test('empty string is zero', () => {
    assert.equal(estimateTokens(''), 0);
  });

  test('ASCII ≈ 4 chars per token, rounded up', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2);
    assert.equal(estimateTokens('a'.repeat(400)), 100);
  });

  test('CJK ≈ 1 token per character (weighted 4×)', () => {
    assert.equal(estimateTokens('测试'), 2);
    assert.equal(estimateTokens('雅思备考计划'), 6);
    // kana and hangul are CJK-weighted too
    assert.equal(estimateTokens('こんにちは'), 5);
    assert.equal(estimateTokens('안녕하세요'), 5);
  });

  test('mixed text sums weights before dividing', () => {
    // 'hi' = 2 units, '测试' = 8 units → 10/4 = 2.5 → 3
    assert.equal(estimateTokens('hi测试'), 3);
  });

  test('monotonic: appending text never lowers the estimate', () => {
    const base = 'The quick brown fox 跳过了 the lazy 狗。';
    let prev = 0;
    for (let i = 0; i <= base.length; i++) {
      const cur = estimateTokens(base.slice(0, i));
      assert.ok(cur >= prev, `estimate dropped at slice ${i}`);
      prev = cur;
    }
  });
});
