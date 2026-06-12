import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { ModelFacingError, FatalError, isModelFacing, isFatal } from '../../../src/kernel/errors.ts';

describe('ModelFacingError', () => {
  test('is an Error with name and model-facing text', () => {
    const err = new ModelFacingError('file not found: /tmp/missing.ts');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'ModelFacingError');
    assert.equal(err.modelText, 'file not found: /tmp/missing.ts');
    assert.match(err.message, /file not found/);
  });

  test('converts to a tool_result block the model can self-repair from (L9)', () => {
    const err = new ModelFacingError('expected integer at $.offset');
    assert.deepEqual(err.toToolResult('call_7'), {
      kind: 'tool_result',
      callId: 'call_7',
      ok: false,
      content: 'expected integer at $.offset',
    });
  });

  test('preserves cause', () => {
    const inner = new Error('ENOENT');
    const err = new ModelFacingError('read failed', { cause: inner });
    assert.equal(err.cause, inner);
  });
});

describe('FatalError', () => {
  test('carries a typed ExitReason', () => {
    const err = new FatalError('budget_tokens', 'token budget exhausted');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'FatalError');
    assert.equal(err.reason, 'budget_tokens');
    assert.match(err.message, /budget/);
  });
});

describe('guards', () => {
  test('isModelFacing / isFatal discriminate correctly', () => {
    const mf = new ModelFacingError('x');
    const fat = new FatalError('fatal_error', 'y');
    const plain = new Error('z');
    assert.equal(isModelFacing(mf), true);
    assert.equal(isModelFacing(fat), false);
    assert.equal(isModelFacing(plain), false);
    assert.equal(isModelFacing('string'), false);
    assert.equal(isFatal(fat), true);
    assert.equal(isFatal(mf), false);
    assert.equal(isFatal(undefined), false);
  });
});
