// The model catalog: built-in profiles plus a user models.json overlay.
// Invalid user entries warn and are skipped — a typo in models.json must
// never take the harness down (same never-throw posture as config/load).

import { readFile } from 'node:fs/promises';
import { validate, type JsonSchema } from '../lib/jsonschema.ts';
import type { ModelProfile } from './profile.ts';

export const BUILTIN_CATALOG: readonly ModelProfile[] = Object.freeze([
  {
    id: 'claude-fable-5',
    wire: 'anthropic',
    contextWindow: 200_000,
    maxOutput: 64_000,
    reasoning: true,
    aliases: ['fable'],
  },
  {
    id: 'claude-opus-4-8',
    wire: 'anthropic',
    contextWindow: 200_000,
    maxOutput: 32_000,
    reasoning: true,
    aliases: ['opus'],
  },
  {
    id: 'claude-sonnet-4-6',
    wire: 'anthropic',
    contextWindow: 200_000,
    maxOutput: 64_000,
    reasoning: true,
    aliases: ['sonnet'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    wire: 'anthropic',
    contextWindow: 200_000,
    maxOutput: 64_000,
    reasoning: false,
    aliases: ['haiku'],
  },
  {
    id: 'gpt-5',
    wire: 'openai',
    contextWindow: 272_000,
    maxOutput: 128_000,
    reasoning: true,
  },
  {
    id: 'gpt-5-mini',
    wire: 'openai',
    contextWindow: 272_000,
    maxOutput: 128_000,
    reasoning: true,
  },
] satisfies ModelProfile[]);

const PROFILE_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['id', 'wire', 'contextWindow', 'maxOutput', 'reasoning'],
  properties: {
    id: { type: 'string' },
    wire: { enum: ['anthropic', 'openai'] },
    contextWindow: { type: 'integer' },
    maxOutput: { type: 'integer' },
    reasoning: { type: 'boolean' },
    aliases: { type: 'array', items: { type: 'string' } },
  },
};

export interface CatalogResult {
  catalog: readonly ModelProfile[];
  warnings: string[];
}

export function mergeCatalog(base: readonly ModelProfile[], overrides: readonly unknown[]): CatalogResult {
  const warnings: string[] = [];
  let catalog = [...base];
  for (const [i, entry] of overrides.entries()) {
    const result = validate(PROFILE_SCHEMA, entry);
    if (!result.ok) {
      const id =
        typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string'
          ? (entry as { id: string }).id
          : `#${i}`;
      const detail = result.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      warnings.push(`models.json entry ${id} invalid (${detail}); skipped`);
      continue;
    }
    const profile = entry as ModelProfile;
    const at = catalog.findIndex((p) => p.id === profile.id);
    catalog = at === -1 ? [...catalog, profile] : catalog.map((p, j) => (j === at ? profile : p));
  }
  return { catalog, warnings };
}

export async function loadCatalog(opts: { file?: string }): Promise<CatalogResult> {
  if (opts.file === undefined) return { catalog: BUILTIN_CATALOG, warnings: [] };
  let text: string;
  try {
    text = await readFile(opts.file, 'utf8');
  } catch {
    return { catalog: BUILTIN_CATALOG, warnings: [] }; // no overlay file is the normal case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { catalog: BUILTIN_CATALOG, warnings: [`${opts.file}: invalid JSON; using built-in catalog`] };
  }
  if (!Array.isArray(parsed)) {
    return { catalog: BUILTIN_CATALOG, warnings: [`${opts.file}: expected a JSON array; using built-in catalog`] };
  }
  return mergeCatalog(BUILTIN_CATALOG, parsed);
}
