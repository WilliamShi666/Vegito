// The model catalog: built-in profiles plus a user models.json overlay.
// Invalid user entries warn and are skipped — a typo in models.json must
// never take the harness down (same never-throw posture as config/load).

import { readFile } from 'node:fs/promises';
import { validate, type JsonSchema } from '../lib/jsonschema.ts';
import type { ModelProfile } from './profile.ts';

export const BUILTIN_CATALOG: readonly ModelProfile[] = Object.freeze([
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
    baseUrl: { type: 'string' },
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

function entriesFromParsed(parsed: unknown, file: string): { entries: readonly unknown[]; warning?: string } {
  if (Array.isArray(parsed)) return { entries: parsed };
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { entries: [], warning: `${file}: expected a JSON array or object with models; using built-in catalog` };
  }
  const models = (parsed as Record<string, unknown>)['models'];
  if (typeof models !== 'object' || models === null || Array.isArray(models)) {
    return { entries: [], warning: `${file}: expected a models object; using built-in catalog` };
  }
  return {
    entries: Object.entries(models as Record<string, unknown>).map(([id, value]) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { id };
      return { id, ...(value as Record<string, unknown>) };
    }),
  };
}

async function readCatalogFile(base: readonly ModelProfile[], file: string): Promise<CatalogResult> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { catalog: base, warnings: [] }; // no overlay file is the normal case
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { catalog: base, warnings: [`${file}: invalid JSON; using prior catalog`] };
  }
  const { entries, warning } = entriesFromParsed(parsed, file);
  if (warning !== undefined) return { catalog: base, warnings: [warning] };
  return mergeCatalog(base, entries);
}

export async function loadCatalog(opts: { file?: string; files?: readonly string[] }): Promise<CatalogResult> {
  const files = opts.files ?? (opts.file === undefined ? [] : [opts.file]);
  let catalog: readonly ModelProfile[] = BUILTIN_CATALOG;
  const warnings: string[] = [];
  for (const file of files) {
    const result = await readCatalogFile(catalog, file);
    catalog = result.catalog;
    warnings.push(...result.warnings);
  }
  return { catalog, warnings };
}
