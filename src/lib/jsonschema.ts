import { canonicalJson } from './hash.ts';

// Minimal JSON-Schema validator covering exactly the subset Vegito emits for
// tool inputs and config (DESIGN: object/array/string/number/integer/boolean/
// null, enum, required, additionalProperties, items). Collects all errors so
// the model gets one complete, repairable message (L9).

export type SchemaType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchema {
  readonly type?: SchemaType;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly description?: string;
}

export interface SchemaError {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: SchemaError[] };

function valueKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeMatches(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    default:
      return valueKind(value) === type;
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const childPath = (path: string, key: string): string =>
  IDENT.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

function check(schema: JsonSchema, value: unknown, path: string, errors: SchemaError[]): void {
  if (schema.type !== undefined && !typeMatches(schema.type, value)) {
    errors.push({ path, message: `expected ${schema.type}, got ${valueKind(value)}` });
    return; // children/enum would only cascade noise onto a wrong-typed value
  }
  if (schema.enum !== undefined) {
    const target = canonicalJson(value);
    if (!schema.enum.some((member) => canonicalJson(member) === target)) {
      errors.push({
        path,
        message: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
      });
      return;
    }
  }
  if (schema.type === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) errors.push({ path, message: `missing required property ${JSON.stringify(key)}` });
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(props)) {
      if (key in obj) check(child, obj[key], childPath(path, key), errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push({ path, message: `unexpected property ${JSON.stringify(key)}` });
      }
    }
  } else if (schema.type === 'array' && schema.items !== undefined) {
    (value as unknown[]).forEach((item, i) => check(schema.items as JsonSchema, item, `${path}[${i}]`, errors));
  }
}

export function validate(schema: JsonSchema, value: unknown): ValidationResult {
  const errors: SchemaError[] = [];
  check(schema, value, '$', errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
