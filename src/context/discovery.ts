// Memory-file discovery (DESIGN §6). Vegito reads project memory (VEGITO.md /
// CLAUDE.md / AGENTS.md) walking up from the working directory toward $HOME,
// then home-level memory under ~/.vegito. Project files precede home files so
// project intent wins precedence when the prompt is assembled. Each file is
// capped at 32 KiB; discovery is pure and deterministic over the filesystem,
// which keeps the frozen T2 snapshot byte-stable for the cache.

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import type { MemoryFile } from './prompt.ts';

export const MEMORY_FILE_CAP = 32 * 1024;
const MEMORY_NAMES = ['VEGITO.md', 'CLAUDE.md', 'AGENTS.md'] as const;
// The home memory index lives under ~/.vegito as MEMORY.md.
const HOME_MEMORY_NAMES = ['MEMORY.md', 'VEGITO.md', 'CLAUDE.md', 'AGENTS.md'] as const;

export interface DiscoveryOptions {
  readonly cwd: string;
  readonly home: string;
}

function readCapped(path: string): string | undefined {
  try {
    const st = statSync(path);
    if (!st.isFile()) return undefined;
    const text = readFileSync(path, 'utf8');
    return text.length > MEMORY_FILE_CAP ? text.slice(0, MEMORY_FILE_CAP) : text;
  } catch {
    return undefined;
  }
}

// Directories from cwd up to (and including) home, nearest first. If cwd is
// not under home we still scan cwd and its ancestors up to the filesystem
// root would be too broad — we stop at home or at the first dir outside it.
function ancestorDirs(cwd: string, home: string): string[] {
  const dirs: string[] = [];
  let cur = cwd;
  for (;;) {
    dirs.push(cur);
    if (cur === home) break;
    const rel = relative(home, cur);
    // Stop once we climb above home (rel starts with '..' or is absolute).
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

export function discoverMemoryFiles(options: DiscoveryOptions): readonly MemoryFile[] {
  const { cwd, home } = options;
  const out: MemoryFile[] = [];
  const seen = new Set<string>();

  const collect = (dir: string, names: readonly string[]): void => {
    for (const name of names) {
      const path = join(dir, name);
      if (seen.has(path)) continue;
      const content = readCapped(path);
      if (content !== undefined) {
        seen.add(path);
        out.push({ path, content });
      }
    }
  };

  for (const dir of ancestorDirs(cwd, home)) collect(dir, MEMORY_NAMES);
  collect(join(home, '.vegito'), HOME_MEMORY_NAMES);
  return out;
}
