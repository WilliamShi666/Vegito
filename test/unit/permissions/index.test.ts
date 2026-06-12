import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import * as permissions from '../../../src/permissions/index.ts';

test('index re-exports the public permission surface', () => {
  assert.equal(typeof permissions.createEngine, 'function');
  assert.equal(typeof permissions.analyzeShell, 'function');
  assert.equal(typeof permissions.resolveWithin, 'function');
  assert.equal(typeof permissions.matchRules, 'function');
  assert.equal(typeof permissions.floorCheck, 'function');
  assert.equal(typeof permissions.freezeMode, 'function');
  assert.equal(typeof permissions.createAskBroker, 'function');
  assert.equal(typeof permissions.createDeferred, 'function');
});
