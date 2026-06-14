// Vegito's documented configuration surface (DESIGN §11). Every key has a
// default; layers can only narrow or override these keys — unknown keys are
// warned about and dropped at load time, never silently carried.

import type { JsonSchema } from '../lib/jsonschema.ts';
import type { ReasoningEffort } from '../providers/types.ts';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypass';
export type PermissionRuleAction = 'read' | 'write' | 'execute' | 'network';
export type PermissionRuleVerdict = 'allow' | 'ask' | 'deny';

export interface ConfigPermissionRule {
  readonly tool: string | '*';
  readonly action?: PermissionRuleAction;
  readonly target?: string;
  readonly verdict: PermissionRuleVerdict;
}

export interface CompactionConfig {
  readonly maxTokens: number;
  readonly protectedTail: number;
}

export interface EvolveConfig {
  readonly defaultApply: boolean;
}

export interface VegitoConfig {
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly maxIterations: number;
  readonly permissionMode: PermissionMode;
  readonly trace: boolean;
  readonly catalogFiles: readonly string[];
  readonly packRoots: readonly string[];
  readonly trustedPacks: readonly string[];
  readonly providerChains: Readonly<Record<string, readonly string[]>>;
  readonly permissionRules: readonly ConfigPermissionRule[];
  readonly compaction: CompactionConfig;
  readonly evolve: EvolveConfig;
}

export const CONFIG_DEFAULTS: VegitoConfig = Object.freeze({
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max',
  maxIterations: 50,
  permissionMode: 'default',
  trace: false,
  catalogFiles: ['catalog/models.json', '~/.vegito/models.json', './.vegito/models.json'],
  packRoots: ['./packs', '~/.vegito/packs'],
  trustedPacks: [],
  providerChains: {},
  permissionRules: [],
  compaction: { maxTokens: 160_000, protectedTail: 8 },
  evolve: { defaultApply: false },
});

const STRING_ARRAY_SCHEMA: JsonSchema = { type: 'array', items: { type: 'string' } };

export const CONFIG_KEY_SCHEMAS: Readonly<Record<keyof VegitoConfig, JsonSchema>> = Object.freeze({
  model: { type: 'string', description: 'model id from the catalog' },
  reasoningEffort: { enum: ['off', 'low', 'medium', 'high', 'max'] },
  maxIterations: { type: 'integer', description: 'max model calls per turn' },
  permissionMode: { enum: ['default', 'acceptEdits', 'plan', 'bypass'] },
  trace: { type: 'boolean', description: 'write a trace log per session' },
  catalogFiles: STRING_ARRAY_SCHEMA,
  packRoots: STRING_ARRAY_SCHEMA,
  trustedPacks: STRING_ARRAY_SCHEMA,
  providerChains: { type: 'object' },
  permissionRules: {
    type: 'array',
    items: {
      type: 'object',
      required: ['tool', 'verdict'],
      properties: {
        tool: { type: 'string' },
        action: { enum: ['read', 'write', 'execute', 'network'] },
        target: { type: 'string' },
        verdict: { enum: ['allow', 'ask', 'deny'] },
      },
      additionalProperties: false,
    },
  },
  compaction: {
    type: 'object',
    properties: {
      maxTokens: { type: 'integer' },
      protectedTail: { type: 'integer' },
    },
    additionalProperties: false,
  },
  evolve: {
    type: 'object',
    properties: {
      defaultApply: { type: 'boolean' },
    },
    additionalProperties: false,
  },
});
