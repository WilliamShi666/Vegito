// Framework-side input validation (DESIGN §7.1): every tool input is checked
// against the spec's schema BEFORE run() — handlers never see junk, and the
// model gets one complete, repairable error message (L9).

import { ModelFacingError } from '../kernel/errors.ts';
import { validate } from '../lib/jsonschema.ts';
import type { ToolSpec } from './spec.ts';

export function validateToolInput<In>(spec: ToolSpec<In>, input: unknown): In {
  const result = validate(spec.schema, input);
  if (!result.ok) {
    const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    throw new ModelFacingError(`invalid input for tool "${spec.name}":\n${detail}`);
  }
  return input as In;
}
