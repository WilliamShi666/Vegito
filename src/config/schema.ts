// Vegito's documented configuration surface (DESIGN §11). Every key has a
// default; layers can only narrow or override these keys — unknown keys are
// warned about and dropped at load time, never silently carried.

import type { JsonSchema } from '../lib/jsonschema.ts';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass';

export interface VegitoConfig {
  readonly model: string;
  readonly maxIterations: number;
  readonly permissionMode: PermissionMode;
  readonly trace: boolean;
}

export const CONFIG_DEFAULTS: VegitoConfig = Object.freeze({
  model: 'claude-fable-5',
  maxIterations: 50,
  permissionMode: 'default',
  trace: false,
});

export const CONFIG_KEY_SCHEMAS: Readonly<Record<keyof VegitoConfig, JsonSchema>> = Object.freeze({
  model: { type: 'string', description: 'model id from the catalog' },
  maxIterations: { type: 'integer', description: 'max model calls per turn' },
  permissionMode: { enum: ['default', 'acceptEdits', 'plan', 'bypass'] },
  trace: { type: 'boolean', description: 'write a trace log per session' },
});
