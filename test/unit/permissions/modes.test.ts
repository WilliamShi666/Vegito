import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  freezeMode,
  deniesNonReadActions,
  allowsWritesInWorkspace,
  bypassesRules,
} from '../../../src/permissions/modes.ts';

describe('freezeMode', () => {
  test('accepts every valid PermissionMode', () => {
    for (const m of ['default', 'acceptEdits', 'plan', 'bypass'] as const) {
      assert.equal(freezeMode(m), m);
    }
  });

  test('rejects an unknown mode', () => {
    assert.throws(() => freezeMode('yolo' as never), /mode/i);
  });

  test('the returned value is the literal, usable in predicates', () => {
    const frozen = freezeMode('bypass');
    assert.equal(bypassesRules(frozen), true);
  });
});

describe('mode predicates', () => {
  test('plan mode denies non-read actions and allows nothing else', () => {
    assert.equal(deniesNonReadActions('plan'), true);
    assert.equal(deniesNonReadActions('default'), false);
    assert.equal(deniesNonReadActions('acceptEdits'), false);
    assert.equal(deniesNonReadActions('bypass'), false);
  });

  test('acceptEdits allows in-workspace writes; no other mode does', () => {
    assert.equal(allowsWritesInWorkspace('acceptEdits'), true);
    assert.equal(allowsWritesInWorkspace('default'), false);
    assert.equal(allowsWritesInWorkspace('plan'), false);
    assert.equal(allowsWritesInWorkspace('bypass'), false);
  });

  test('only bypass skips the rule tables', () => {
    assert.equal(bypassesRules('bypass'), true);
    assert.equal(bypassesRules('default'), false);
    assert.equal(bypassesRules('acceptEdits'), false);
    assert.equal(bypassesRules('plan'), false);
  });
});
