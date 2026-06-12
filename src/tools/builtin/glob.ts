// glob builtin (DESIGN §7.1): file-name pattern matching via node:fs glob.
// Read-class and parallel-safe. node_modules and .git are pruned by default —
// the model almost never wants them, and when it does, bash is right there.

import { glob } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defineTool } from '../spec.ts';
import { isPruned } from './walk.ts';

export interface GlobIn {
  readonly pattern: string;
  readonly path?: string;
}

export const globTool = defineTool<GlobIn>({
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "**/*.ts"). Returns absolute paths, sorted. ' +
    'Searches the working directory unless path is given. Skips node_modules and .git.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts"' },
      path: { type: 'string', description: 'Directory to search (defaults to cwd)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  concurrencySafe: () => true,
  permissionKey: (input) => ({ tool: 'glob', action: 'read', ...(input.path === undefined ? {} : { target: input.path }) }),
  run: async (input, ctx) => {
    const root = resolve(ctx.cwd, input.path ?? '.');
    const found: string[] = [];
    for await (const entry of glob(input.pattern, {
      cwd: root,
      exclude: isPruned,
    })) {
      found.push(join(root, entry));
    }
    if (found.length === 0) return { content: `(no matches) pattern ${input.pattern} under ${root}` };
    found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return { content: found.join('\n') };
  },
});
