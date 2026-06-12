import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { validate, type JsonSchema } from '../../../src/lib/jsonschema.ts';

interface AcceptCase {
  name: string;
  schema: JsonSchema;
  value: unknown;
  ok: true;
}
interface RejectCase {
  name: string;
  schema: JsonSchema;
  value: unknown;
  ok: false;
  errors: { path: string; match: RegExp }[];
}

const FILE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    offset: { type: 'integer' },
    follow: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    mode: { type: 'string', enum: ['read', 'write'] },
  },
  required: ['path'],
  additionalProperties: false,
};

const cases: (AcceptCase | RejectCase)[] = [
  { name: 'string accepts string', schema: { type: 'string' }, value: 'hi', ok: true },
  {
    name: 'string rejects number with type message',
    schema: { type: 'string' },
    value: 7,
    ok: false,
    errors: [{ path: '$', match: /expected string, got number/ }],
  },
  { name: 'number accepts float', schema: { type: 'number' }, value: 1.5, ok: true },
  {
    name: 'integer rejects float',
    schema: { type: 'integer' },
    value: 1.5,
    ok: false,
    errors: [{ path: '$', match: /expected integer/ }],
  },
  { name: 'integer accepts whole number', schema: { type: 'integer' }, value: 3, ok: true },
  { name: 'boolean accepts true', schema: { type: 'boolean' }, value: true, ok: true },
  {
    name: 'boolean rejects string',
    schema: { type: 'boolean' },
    value: 'true',
    ok: false,
    errors: [{ path: '$', match: /expected boolean, got string/ }],
  },
  { name: 'null accepts null', schema: { type: 'null' }, value: null, ok: true },
  {
    name: 'object rejects null (null is not object)',
    schema: { type: 'object' },
    value: null,
    ok: false,
    errors: [{ path: '$', match: /expected object, got null/ }],
  },
  {
    name: 'object rejects array',
    schema: { type: 'object' },
    value: [],
    ok: false,
    errors: [{ path: '$', match: /expected object, got array/ }],
  },
  { name: 'enum accepts member', schema: { type: 'string', enum: ['a', 'b'] }, value: 'b', ok: true },
  {
    name: 'enum rejects non-member listing allowed values',
    schema: { type: 'string', enum: ['read', 'write'] },
    value: 'append',
    ok: false,
    errors: [{ path: '$', match: /expected one of \["read","write"\], got "append"/ }],
  },
  { name: 'full object accepts minimal valid input', schema: FILE_SCHEMA, value: { path: '/tmp/x' }, ok: true },
  {
    name: 'full object accepts all fields',
    schema: FILE_SCHEMA,
    value: { path: '/x', offset: 0, follow: false, tags: ['a'], mode: 'read' },
    ok: true,
  },
  {
    name: 'missing required property',
    schema: FILE_SCHEMA,
    value: { offset: 1 },
    ok: false,
    errors: [{ path: '$', match: /missing required property "path"/ }],
  },
  {
    name: 'unexpected property when additionalProperties=false',
    schema: FILE_SCHEMA,
    value: { path: '/x', bogus: 1 },
    ok: false,
    errors: [{ path: '$', match: /unexpected property "bogus"/ }],
  },
  {
    name: 'additionalProperties defaults to allowed',
    schema: { type: 'object', properties: { a: { type: 'string' } } },
    value: { a: 'x', extra: 42 },
    ok: true,
  },
  {
    name: 'nested property error carries its path',
    schema: FILE_SCHEMA,
    value: { path: '/x', tags: ['ok', 7] },
    ok: false,
    errors: [{ path: '$.tags[1]', match: /expected string, got number/ }],
  },
  {
    name: 'array rejects non-array',
    schema: { type: 'array', items: { type: 'number' } },
    value: 'nope',
    ok: false,
    errors: [{ path: '$', match: /expected array, got string/ }],
  },
  {
    name: 'multiple errors are all collected',
    schema: FILE_SCHEMA,
    value: { offset: 'zero', bogus: true },
    ok: false,
    errors: [
      { path: '$', match: /missing required property "path"/ },
      { path: '$.offset', match: /expected integer/ },
      { path: '$', match: /unexpected property "bogus"/ },
    ],
  },
  {
    name: 'deep nesting paths use bracket+dot form',
    schema: {
      type: 'object',
      properties: { rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false } } },
      required: ['rows'],
      additionalProperties: false,
    },
    value: { rows: [{ id: 1 }, { id: 'two' }] },
    ok: false,
    errors: [{ path: '$.rows[1].id', match: /expected integer, got string/ }],
  },
];

describe('jsonschema.validate', () => {
  for (const c of cases) {
    test(c.name, () => {
      const result = validate(c.schema, c.value);
      if (c.ok) {
        assert.deepEqual(result, { ok: true }, JSON.stringify(result));
        return;
      }
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.errors.length, c.errors.length, JSON.stringify(result.errors));
      for (let i = 0; i < c.errors.length; i++) {
        const want = c.errors[i] as RejectCase['errors'][number];
        const got = result.errors[i] as { path: string; message: string };
        assert.equal(got.path, want.path, `error[${i}] path`);
        assert.match(got.message, want.match, `error[${i}] message`);
      }
    });
  }

  test('rejection result formats as model-facing text', () => {
    const result = validate(FILE_SCHEMA, { offset: 'zero' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    const text = result.errors.map((e) => `at ${e.path}: ${e.message}`).join('\n');
    assert.match(text, /at \$: missing required property "path"/);
    assert.match(text, /at \$\.offset: expected integer/);
  });
});
