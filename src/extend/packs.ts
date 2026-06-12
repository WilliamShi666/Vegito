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
}

// Paths that must be validated when present.
const PATH_KEYS = ['persona', 'skills', 'commands', 'hooks'] as const;

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

  const grantsRaw = obj['grants'];
  const grants: string[] = Array.isArray(grantsRaw) ? grantsRaw.filter((g): g is string => typeof g === 'string') : [];

  const manifest: Record<string, unknown> = { schema: 1, name, version, description, grants };
  for (const key of PATH_KEYS) {
    const val = asString(obj[key]);
    if (val !== undefined) manifest[key] = val;
  }
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
  for (const key of PATH_KEYS) {
    const val = (manifest as unknown as Record<string, string | undefined>)[key];
    if (val !== undefined && !validatePackPath(root, val)) {
      throw new Error(`pack "${manifest.name}" declares an unsafe ${key} path: ${val} (must be ./-relative, no "..", inside the pack)`);
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
