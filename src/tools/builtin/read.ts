// read builtin (DESIGN §7.1): numbered window over a text file. Read-class,
// parallel-safe. Notes every successful read in the FileState ledger — that
// note is what authorizes a later write/edit to the same path.

import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';

export interface ReadIn {
  readonly file_path: string;
  readonly offset?: number;
  readonly limit?: number;
}

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

export const readTool = defineTool<ReadIn>({
  name: 'read',
  description:
    'Read a text file with line numbers. Use offset (1-based) and limit to window large files. ' +
    'Reading a file is what permits writing or editing it later.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path to the file' },
      offset: { type: 'integer', description: '1-based line number to start from' },
      limit: { type: 'integer', description: 'Maximum number of lines to return' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  concurrencySafe: () => true,
  permissionKey: (input) => ({ tool: 'read', action: 'read', target: input.file_path }),
  run: async (input, ctx) => {
    const path = resolve(ctx.cwd, input.file_path);
    const st = await stat(path).catch(() => undefined);
    if (st === undefined) throw new ModelFacingError(`file does not exist: ${path}`);
    if (st.isDirectory()) throw new ModelFacingError(`${path} is a directory — use the ls tool to list it`);

    if (IMAGE_EXTS.has(extname(path).toLowerCase())) {
      ctx.files.noteSeen(path, st.mtimeMs);
      return { content: `[image: ${path}, ${st.size} bytes — binary content not rendered]` };
    }

    const raw = await readFile(path, 'utf8');
    ctx.files.noteSeen(path, st.mtimeMs);
    if (raw.length === 0) return { content: '(empty file)' };

    const all = raw.split('\n');
    if (all.at(-1) === '') all.pop(); // trailing newline is not an extra line

    const offset = input.offset ?? 1;
    const limit = input.limit ?? MAX_LINES;
    const window = all.slice(offset - 1, offset - 1 + limit);
    const body = window
      .map((line, i) => `${String(offset + i).padStart(6)}\t${line.slice(0, MAX_LINE_CHARS)}`)
      .join('\n');

    const lastShown = offset - 1 + window.length;
    const remaining = all.length - lastShown;
    // Note the cut only when OUR default cap did it; an explicit limit is the
    // model windowing deliberately (it can infer EOF from a short result).
    if (remaining > 0 && input.limit === undefined) {
      return { content: `${body}\n[truncated: ${remaining} more lines — re-read with offset=${lastShown + 1}]` };
    }
    return { content: body };
  },
});
