import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { validateToolInput } from '../../../src/tools/validate.ts';
import { defineTool } from '../../../src/tools/spec.ts';
import { ModelFacingError } from '../../../src/kernel/errors.ts';

const tool = defineTool<{ path: string; limit?: number }>({
  name: 'read',
  description: 'reads a file',
  schema: {
    type: 'object',
    properties: { path: { type: 'string' }, limit: { type: 'integer' } },
    required: ['path'],
    additionalProperties: false,
  },
  run: async (input) => ({ content: input.path }),
});

describe('validateToolInput', () => {
  test('valid input passes through typed and untouched', () => {
    const input = { path: '/a.txt', limit: 5 };
    assert.equal(validateToolInput(tool, input), input);
  });

  test('invalid input throws ModelFacingError naming the tool and every error', () => {
    assert.throws(
      () => validateToolInput(tool, { limit: 'many', extra: 1 }),
      (err: unknown) => {
        assert.ok(err instanceof ModelFacingError);
        assert.match(err.modelText, /read/); // which tool
        assert.match(err.modelText, /"path"/); // missing required
        assert.match(err.modelText, /limit.*expected integer/); // wrong type
        assert.match(err.modelText, /"extra"/); // unexpected key — all errors at once (L9)
        return true;
      },
    );
  });

  test('non-object input is a model-facing failure, not a crash', () => {
    assert.throws(
      () => validateToolInput(tool, 'just a string'),
      (err: unknown) => err instanceof ModelFacingError,
    );
  });
});
