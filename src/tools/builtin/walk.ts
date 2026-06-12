// Shared walk policy for the search builtins (glob, grep): node_modules and
// .git are pruned — the model almost never wants them, and when it does,
// bash is right there.

import type { Dirent } from 'node:fs';

const PRUNED = new Set(['node_modules', '.git']);

// Node's glob exclude callback receives a relative path string in some 22.x
// releases and a Dirent in later ones — normalize to the entry's base name.
function baseName(entry: string | Dirent): string {
  if (typeof entry !== 'string') return entry.name;
  const last = entry.split('/').pop();
  return last === undefined || last === '' ? entry : last;
}

/** glob() exclude callback: prune node_modules and .git at any depth. */
export function isPruned(entry: string | Dirent): boolean {
  return PRUNED.has(baseName(entry));
}
