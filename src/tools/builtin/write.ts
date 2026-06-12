// write builtin (DESIGN §7.1): full-file create/overwrite. Two safety rails,
// both backed by the FileState ledger: an existing file must have been read
// this session, and must not have changed on disk since that read.

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';

export interface WriteIn {
  readonly file_path: string;
  readonly content: string;
}

export const writeTool = defineTool<WriteIn>({
  name: 'write',
  description:
    'Write a file (create or full overwrite). Overwriting an existing file requires reading it first; ' +
    'a file that changed on disk since your read is refused — re-read it.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path to write' },
      content: { type: 'string', description: 'Full file content' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  permissionKey: (input) => ({ tool: 'write', action: 'write', target: input.file_path }),
  run: async (input, ctx) => {
    const path = resolve(ctx.cwd, input.file_path);
    const st = await stat(path).catch(() => undefined);
    if (st !== undefined) {
      const seen = ctx.files.seenAt(path);
      if (seen === undefined) {
        throw new ModelFacingError(`refusing to overwrite ${path}: read it first so you know what you are replacing`);
      }
      if (st.mtimeMs > seen) {
        throw new ModelFacingError(`${path} was modified on disk after your last read — re-read it before overwriting`);
      }
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, 'utf8');
    const after = await stat(path);
    ctx.files.noteSeen(path, after.mtimeMs);
    return { content: `wrote ${input.content.length} chars to ${path}` };
  },
});
