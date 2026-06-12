// Workspace containment (DESIGN §7.2): resolve a path the way the kernel
// will actually traverse it, then test containment. Two classic bypasses are
// closed by construction:
//   - textual ".." collapse across symlinks (link/../x must follow the link
//     TARGET's parent) — we walk segment by segment, canonicalizing each
//     existing prefix before applying "..";
//   - prefix-string containment (/work vs /work2) — we compare with
//     path.relative, never startsWith.
// Nonexistent suffixes are joined textually, which is sound: nothing can be
// a symlink under a directory that does not exist.

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface ResolvedPath {
  /** True iff the fully resolved path is the workspace or under it. */
  readonly inside: boolean;
  /** The canonical absolute path (existing prefix realpathed). */
  readonly real: string;
}

export function resolveWithin(workspace: string, p: string): ResolvedPath {
  const wsReal = realpathSync(workspace); // workspace must exist — caller bug otherwise
  // Concatenate WITHOUT path.join/resolve: those collapse ".." textually,
  // which is the precise bug the segment walk exists to avoid.
  const abs = isAbsolute(p) ? p : `${wsReal}${sep}${p}`;

  // Walk segments left to right. `cur` is always canonical while the path
  // still exists; once a segment is missing we switch to textual joining.
  let cur = resolve(sep); // filesystem root
  let exists = true;
  for (const seg of abs.split(sep)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, seg);
    if (exists) {
      try {
        cur = realpathSync(next);
        continue;
      } catch {
        exists = false; // ENOENT (or unreadable) — textual from here on
      }
    }
    cur = next;
  }

  const rel = relative(wsReal, cur);
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return { inside, real: cur };
}
