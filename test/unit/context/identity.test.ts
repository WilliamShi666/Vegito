// P10 identity/constitution copy: the static bytes of system tier T1. Kept in
// one module so the CLI, forge, and tests all assemble the same prefix (D4 —
// the cache anchor must be byte-identical everywhere). Content only; assembly
// and freezing live in context/prompt.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDENTITY, CONSTITUTION } from '../../../src/context/identity.ts';

test('IDENTITY names Vegito and is a non-empty single block', () => {
  assert.equal(typeof IDENTITY, 'string');
  assert.ok(IDENTITY.length > 0);
  assert.match(IDENTITY, /Vegito/);
});

test('CONSTITUTION is a frozen non-empty list of one-line principles', () => {
  assert.ok(Array.isArray(CONSTITUTION));
  assert.ok(CONSTITUTION.length >= 3);
  assert.ok(Object.isFrozen(CONSTITUTION));
  for (const line of CONSTITUTION) {
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0);
    assert.ok(!line.includes('\n'), 'each principle is a single line');
  }
});

test('identity copy is stable across imports (byte anchor, D4)', async () => {
  const again = await import('../../../src/context/identity.ts');
  assert.equal(again.IDENTITY, IDENTITY);
  assert.equal(again.CONSTITUTION, CONSTITUTION);
});
