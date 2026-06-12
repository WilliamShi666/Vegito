// P8 packs (DESIGN §8). A pack bundles persona, agents, skills, commands,
// hooks, rubrics, and memory seeds behind one manifest. Two invariants are
// enforced here because they are the pack security boundary:
//   1. schema:1 only — there is never a legacy migration path (A9), so an
//      unknown schema is a hard reject, not a best-effort parse.
//   2. every manifest-declared path is "./"-prefixed, contains no "..", and
//      resolves inside the pack root. A pack may describe its own files and
//      nothing else; this is what makes installing an untrusted pack safe.
// Tool grants default to empty: a pack gets no tools until its manifest names
// them, and even then they run under the same permission gate (no backdoor).

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';

export interface PackAgent {
  readonly name: string;
  /** Tier indirection (e.g. "tier:smart"); the runtime maps tiers to the user's chain. */
  readonly model: string;
  readonly tools: readonly string[];
  readonly prompt: string;
}

export interface PackRubric {
  readonly name: string;
  /** Soft check: a prompt the model grades against (§5.2). */
  readonly prompt: string;
  /** Hard check: an executable that pairs with the prompt. */
  readonly validator: string;
}

export interface PackMemory {
  readonly seeds?: string;
  readonly promotion?: string;
}

export interface PackManifest {
  readonly schema: 1;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly persona?: string;
  readonly skills?: string;
  readonly commands?: string;
  readonly hooks?: string;
  readonly grants: readonly string[];
  readonly agents: readonly PackAgent[];
  readonly rubrics: readonly PackRubric[];
  readonly memory?: PackMemory;
  readonly onboarding?: string;
  /** Tier name → resolution hint ("best-available" etc.). No vendor names (A6). */
  readonly modelTiers: Readonly<Record<string, string>>;
}

// Single-string path keys validated when present.
const PATH_KEYS = ['persona', 'skills', 'commands', 'hooks', 'onboarding'] as const;

export function validatePackPath(_root: string, p: string): boolean {
  if (typeof p !== 'string' || p === '') return false;
  if (!p.startsWith('./')) return false; // must be explicitly pack-relative
  if (isAbsolute(p)) return false;
  // Reject any ".." segment, before or after normalization.
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.some((s) => s === '..')) return false;
  const norm = normalize(p);
  if (norm.startsWith('..') || isAbsolute(norm)) return false;
  return true;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function parseAgents(v: unknown): PackAgent[] {
  if (!Array.isArray(v)) return [];
  const out: PackAgent[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const name = asString(o['name']);
    const model = asString(o['model']);
    const prompt = asString(o['prompt']);
    if (name === undefined || model === undefined || prompt === undefined) continue;
    out.push({ name, model, prompt, tools: asStringArray(o['tools']) });
  }
  return out;
}

function parseRubrics(v: unknown): PackRubric[] {
  if (!Array.isArray(v)) return [];
  const out: PackRubric[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const name = asString(o['name']);
    if (name === undefined) continue;
    // prompt/validator may be missing — that is a semantic problem the validator
    // reports, not a parse failure (we keep the entry so the gap is visible).
    out.push({ name, prompt: asString(o['prompt']) ?? '', validator: asString(o['validator']) ?? '' });
  }
  return out;
}

function parseMemory(v: unknown): PackMemory | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const mem: Record<string, string> = {};
  const seeds = asString(o['seeds']);
  if (seeds !== undefined) mem['seeds'] = seeds;
  const promotion = asString(o['promotion']);
  if (promotion !== undefined) mem['promotion'] = promotion;
  return Object.keys(mem).length > 0 ? (mem as PackMemory) : undefined;
}

function parseTiers(v: unknown): Record<string, string> {
  if (typeof v !== 'object' || v === null) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}

export function parseManifest(text: string): PackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`pack.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('pack.json must be a JSON object');
  const obj = raw as Record<string, unknown>;

  if (obj['schema'] !== 1) throw new Error(`unsupported pack schema ${String(obj['schema'])} — only schema:1 is supported`);
  const name = asString(obj['name']);
  if (name === undefined || name === '') throw new Error('pack.json is missing name');
  const version = asString(obj['version']);
  if (version === undefined || version === '') throw new Error('pack.json is missing version');
  const description = asString(obj['description']) ?? '';

  const grants = asStringArray(obj['grants']);

  const manifest: Record<string, unknown> = {
    schema: 1,
    name,
    version,
    description,
    grants,
    agents: parseAgents(obj['agents']),
    rubrics: parseRubrics(obj['rubrics']),
    modelTiers: parseTiers(obj['modelTiers']),
  };
  for (const key of PATH_KEYS) {
    const val = asString(obj[key]);
    if (val !== undefined) manifest[key] = val;
  }
  const memory = parseMemory(obj['memory']);
  if (memory !== undefined) manifest['memory'] = memory;
  return manifest as unknown as PackManifest;
}

export interface LoadedPack {
  readonly root: string;
  readonly manifest: PackManifest;
  readonly personaPath?: string;
  readonly skillsDir?: string;
  readonly commandsDir?: string;
  readonly hooksDir?: string;
}

// Every pack-relative path the manifest declares, across all sections. Used by
// loadPack (path-safety) and by pack-validate (existence + content checks).
export function declaredPaths(manifest: PackManifest): readonly string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const val = (manifest as unknown as Record<string, string | undefined>)[key];
    if (val !== undefined) paths.push(val);
  }
  for (const a of manifest.agents) paths.push(a.prompt);
  for (const r of manifest.rubrics) {
    if (r.prompt !== '') paths.push(r.prompt);
    if (r.validator !== '') paths.push(r.validator);
  }
  if (manifest.memory?.seeds !== undefined) paths.push(manifest.memory.seeds);
  return paths;
}

export async function loadPack(root: string): Promise<LoadedPack> {
  const manifestPath = join(root, 'pack.json');
  let text: string;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`pack.json not found in ${root}`);
  }
  const manifest = parseManifest(text);

  // Validate every declared path before resolving any of them.
  for (const p of declaredPaths(manifest)) {
    if (!validatePackPath(root, p)) {
      throw new Error(`pack "${manifest.name}" declares an unsafe path: ${p} (must be ./-relative, no "..", inside the pack)`);
    }
  }

  const resolve = (rel: string | undefined): string | undefined =>
    rel === undefined ? undefined : join(root, rel.replace(/^\.\//, '').split('/').join(sep));

  const loaded: Record<string, unknown> = { root, manifest };
  const persona = resolve(manifest.persona);
  if (persona !== undefined) loaded['personaPath'] = persona;
  const skills = resolve(manifest.skills);
  if (skills !== undefined) loaded['skillsDir'] = skills;
  const commands = resolve(manifest.commands);
  if (commands !== undefined) loaded['commandsDir'] = commands;
  const hooks = resolve(manifest.hooks);
  if (hooks !== undefined) loaded['hooksDir'] = hooks;
  return loaded as unknown as LoadedPack;
}
