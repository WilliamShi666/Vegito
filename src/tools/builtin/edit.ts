// edit builtin (DESIGN §7.1): exact-string replacement with the unique-match
// contract — zero matches and ambiguous matches are both refused, atomically.
// Same FileState rails as write: must be read, must not be stale.

import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';

export interface EditIn {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
  readonly replace_all?: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

export const editTool = defineTool<EditIn>({
  name: 'edit',
  description:
    'Replace an exact string in a file. old_string must match exactly once — include surrounding ' +
    'lines to disambiguate, or set replace_all to replace every occurrence. Read the file first.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path to edit' },
      old_string: { type: 'string', description: 'Exact text to replace (must be unique unless replace_all)' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  permissionKey: (input) => ({ tool: 'edit', action: 'write', target: input.file_path }),
  run: async (input, ctx) => {
    if (input.old_string === '') {
      throw new ModelFacingError('old_string must not be empty — to create or overwrite a file, use write');
    }
    if (input.old_string === input.new_string) {
      throw new ModelFacingError('old_string and new_string are identical — nothing would change');
    }
    const path = resolve(ctx.cwd, input.file_path);
    const st = await stat(path).catch(() => undefined);
    if (st === undefined) throw new ModelFacingError(`file does not exist: ${path}`);
    const seen = ctx.files.seenAt(path);
    if (seen === undefined) {
      throw new ModelFacingError(`refusing to edit ${path}: read it first so your old_string matches reality`);
    }
    if (st.mtimeMs > seen) {
      throw new ModelFacingError(`${path} was modified on disk after your last read — re-read it before editing`);
    }

    const text = await readFile(path, 'utf8');
    const count = countOccurrences(text, input.old_string);
    if (count === 0) {
      throw new ModelFacingError(
        `old_string not found in ${path} — re-read the file; whitespace and indentation must match exactly`,
      );
    }
    if (count > 1 && input.replace_all !== true) {
      throw new ModelFacingError(
        `old_string matches ${count} times in ${path} — include more surrounding context to make it unique, ` +
          'or set replace_all: true',
      );
    }

    const next =
      input.replace_all === true
        ? text.split(input.old_string).join(input.new_string)
        : text.replace(input.old_string, input.new_string);
    await writeFile(path, next, 'utf8');
    const after = await stat(path);
    ctx.files.noteSeen(path, after.mtimeMs);
    return { content: `edited ${path}: ${count} replacement${count === 1 ? '' : 's'}` };
  },
});
