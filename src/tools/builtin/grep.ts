// grep builtin (DESIGN §7.1): regex content search over glob candidates.
// Stdlib recursive scan — no ripgrep dependency (D1). Binary files are
// sniffed (NUL in the first 4 KiB) and skipped; matches are capped so a
// pathological pattern cannot flood the transcript.

import { glob, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';
import { isPruned } from './walk.ts';

export interface GrepIn {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly ignore_case?: boolean;
}

const MAX_MATCHES = 500;
const SNIFF_BYTES = 4096;

export const grepTool = defineTool<GrepIn>({
  name: 'grep',
  description:
    'Search file contents with a JavaScript regex. Returns path:line:text matches, sorted by path. ' +
    'Use glob to narrow candidate files (default "**/*"). Skips node_modules, .git, and binary files.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for' },
      path: { type: 'string', description: 'Directory to search (defaults to cwd)' },
      glob: { type: 'string', description: 'Candidate file filter, e.g. "**/*.ts" (default all files)' },
      ignore_case: { type: 'boolean', description: 'Case-insensitive match (default false)' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  concurrencySafe: () => true,
  permissionKey: (input) => ({ tool: 'grep', action: 'read', ...(input.path === undefined ? {} : { target: input.path }) }),
  run: async (input, ctx) => {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignore_case === true ? 'i' : '');
    } catch (err) {
      throw new ModelFacingError(
        `invalid regex pattern ${JSON.stringify(input.pattern)}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const root = resolve(ctx.cwd, input.path ?? '.');
    const candidates: string[] = [];
    for await (const entry of glob(input.glob ?? '**/*', {
      cwd: root,
      exclude: isPruned,
    })) {
      candidates.push(join(root, entry));
    }
    candidates.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const matches: string[] = [];
    let total = 0;
    for (const file of candidates) {
      const st = await stat(file).catch(() => undefined);
      if (st === undefined || !st.isFile()) continue;
      const buf = await readFile(file).catch(() => undefined);
      if (buf === undefined) continue;
      if (buf.subarray(0, SNIFF_BYTES).includes(0)) continue; // binary
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (!re.test(line)) continue;
        total++;
        if (matches.length < MAX_MATCHES) matches.push(`${file}:${i + 1}:${line}`);
      }
    }

    if (total === 0) return { content: `(no matches) pattern ${input.pattern} under ${root}` };
    if (total > matches.length) {
      return { content: `${matches.join('\n')}\n[truncated: ${total - matches.length} more matches]` };
    }
    return { content: matches.join('\n') };
  },
});
