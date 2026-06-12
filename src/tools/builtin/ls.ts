// ls builtin (DESIGN §7.1): one directory level, sorted, dirs marked with '/'.
// Read-class and parallel-safe. Capped so a pathological directory cannot
// flood the transcript (the message budget would catch it anyway — L9 twice).

import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';

export interface LsIn {
  readonly path?: string;
}

const MAX_ENTRIES = 1000;

export const lsTool = defineTool<LsIn>({
  name: 'ls',
  description: 'List one directory level (sorted; directories end with /). Defaults to the working directory.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (defaults to cwd)' },
    },
    additionalProperties: false,
  },
  concurrencySafe: () => true,
  permissionKey: (input) => ({ tool: 'ls', action: 'read', ...(input.path === undefined ? {} : { target: input.path }) }),
  run: async (input, ctx) => {
    const path = resolve(ctx.cwd, input.path ?? '.');
    const st = await stat(path).catch(() => undefined);
    if (st === undefined) throw new ModelFacingError(`path does not exist: ${path}`);
    if (!st.isDirectory()) throw new ModelFacingError(`${path} is not a directory — use read for files`);

    const entries = await readdir(path, { withFileTypes: true });
    if (entries.length === 0) return { content: `(empty directory) ${path}` };

    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (names.length > MAX_ENTRIES) {
      const shown = names.slice(0, MAX_ENTRIES - 1);
      return { content: `${shown.join('\n')}\n[truncated: ${names.length - shown.length} more entries]` };
    }
    return { content: names.join('\n') };
  },
});
