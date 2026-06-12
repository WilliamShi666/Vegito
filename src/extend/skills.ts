// P8 skills (DESIGN §8): a skill is a directory containing SKILL.md. The
// frontmatter (name, description) is Tier-1 — cheap, always in the `skill`
// tool description. The body is Tier-2 — loaded into the transcript only when
// the model invokes the skill. discoverSkills scans roots in precedence order
// (project before home); the first occurrence of a name wins. The result
// satisfies the SkillSource contract the builtin `skill` tool consumes, so the
// registry hands disk-backed skills straight into the tool layer.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillMeta, SkillSource } from '../tools/builtin/skill.ts';

export interface SkillFrontmatter {
  readonly meta: SkillMeta;
  readonly body: string;
}

const FRONT_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const m = FRONT_RE.exec(text);
  if (!m) throw new Error('SKILL.md is missing frontmatter');
  const front = m[1] ?? '';
  const body = m[2] ?? '';
  let name: string | undefined;
  let description = '';
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key === 'name') name = val;
    else if (key === 'description') description = val;
  }
  if (name === undefined || name === '') throw new Error('SKILL.md frontmatter is missing name');
  return { meta: { name, description }, body };
}

interface Entry {
  readonly meta: SkillMeta;
  readonly path: string;
}

function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// A SKILL.md may sit directly in the root (root/SKILL.md) or, conventionally,
// one level down (root/<skill>/SKILL.md). We scan immediate subdirectories.
function scanRoot(root: string, out: Map<string, Entry>): void {
  for (const child of readDirNames(root)) {
    const skillFile = join(root, child, 'SKILL.md');
    let text: string;
    try {
      if (!statSync(skillFile).isFile()) continue;
      text = readFileSync(skillFile, 'utf8');
    } catch {
      continue;
    }
    let parsed: SkillFrontmatter;
    try {
      parsed = parseSkillFrontmatter(text);
    } catch {
      continue; // malformed skill is skipped, not fatal
    }
    if (!out.has(parsed.meta.name)) out.set(parsed.meta.name, { meta: parsed.meta, path: skillFile });
  }
}

export function discoverSkills(roots: readonly string[]): SkillSource {
  const entries = new Map<string, Entry>();
  for (const root of roots) scanRoot(root, entries);

  const metas: SkillMeta[] = [...entries.values()]
    .map((e) => e.meta)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    list: () => metas,
    load: async (name: string): Promise<string | undefined> => {
      const entry = entries.get(name);
      if (!entry) return undefined;
      try {
        return parseSkillFrontmatter(readFileSync(entry.path, 'utf8')).body;
      } catch {
        return undefined;
      }
    },
  };
}

/** Synchronous skill bodies for the skills-as-commands bridge (DESIGN §8). */
export function discoverSkillBodies(
  roots: readonly string[],
): readonly { name: string; description: string; body: string }[] {
  const entries = new Map<string, Entry>();
  for (const root of roots) scanRoot(root, entries);
  const out: { name: string; description: string; body: string }[] = [];
  for (const entry of entries.values()) {
    try {
      const body = parseSkillFrontmatter(readFileSync(entry.path, 'utf8')).body;
      out.push({ name: entry.meta.name, description: entry.meta.description, body });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
