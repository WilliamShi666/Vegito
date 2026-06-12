// Shared builtin-test scaffolding: a ToolCtx with a fresh FileState, rooted at
// a caller-provided cwd (usually a mkdtemp sandbox).

import { FileState } from '../../src/context/filestate.ts';
import type { ToolCtx } from '../../src/tools/spec.ts';

export function mkCtx(cwd: string): ToolCtx {
  return { cwd, signal: new AbortController().signal, files: new FileState() };
}
