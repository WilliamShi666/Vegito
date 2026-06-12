import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { VERSION } from '../../src/version.ts';

test('scaffold: TypeScript runs natively and src imports resolve', () => {
  assert.equal(typeof VERSION, 'string');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});
