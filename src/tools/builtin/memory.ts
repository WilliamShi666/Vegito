// memory builtin (DESIGN §7.1): persistent cross-session notes, one file per
// memory under a harness-owned directory. Names are sanitized so a hostile
// name cannot escape the dir (same containment trick as SpillStore). The
// permission class is dynamic: list/read are read-class, save is write-class.

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';
import type { ToolSpec } from '../spec.ts';

export type MemoryAction = 'save' | 'list' | 'read';

export interface MemoryIn {
  readonly action: MemoryAction;
  readonly name?: string;
  readonly content?: string;
}

function safeName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '');
  if (safe === '') throw new ModelFacingError(`memory name ${JSON.stringify(name)} reduces to nothing safe — use letters, digits, dashes`);
  return safe;
}

export function makeMemoryTool(dir: string): ToolSpec<MemoryIn> {
  let ready: Promise<void> | undefined;
  const ensureDir = (): Promise<void> => {
    ready ??= mkdir(dir, { recursive: true }).then(() => undefined);
    return ready;
  };

  return defineTool<MemoryIn>({
    name: 'memory',
    description:
      'Persistent notes that survive across sessions. save {name, content} writes or overwrites ' +
      'a memory; list shows all names; read {name} returns one. Use for durable facts about the ' +
      'user or project, not scratch state.',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'read'], description: 'What to do' },
        name: { type: 'string', description: 'Memory name (save, read)' },
        content: { type: 'string', description: 'Memory body (save)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    concurrencySafe: (input) => input.action !== 'save',
    permissionKey: (input) =>
      input.action === 'save'
        ? { tool: 'memory', action: 'write', target: dir }
        : { tool: 'memory', action: 'read', target: dir },
    run: async (input) => {
      if (input.action === 'save') {
        if (input.name === undefined || input.content === undefined) {
          throw new ModelFacingError('memory save needs both name and content');
        }
        await ensureDir();
        const file = safeName(input.name);
        await writeFile(join(dir, `${file}.md`), input.content, 'utf8');
        return { content: `memory saved: ${file}` };
      }
      if (input.action === 'read') {
        if (input.name === undefined) throw new ModelFacingError('memory read needs a name');
        const file = safeName(input.name);
        const text = await readFile(join(dir, `${file}.md`), 'utf8').catch(() => undefined);
        if (text === undefined) throw new ModelFacingError(`no memory named ${file} — use list to see what exists`);
        return { content: text };
      }
      if (input.action === 'list') {
        const entries = await readdir(dir).catch(() => [] as string[]);
        const names = entries.filter((e) => e.endsWith('.md')).map((e) => e.slice(0, -3)).sort();
        if (names.length === 0) return { content: '(no memories saved yet)' };
        return { content: names.join('\n') };
      }
      throw new ModelFacingError(`unknown memory action ${JSON.stringify(input.action)} — use save, list, or read`);
    },
  });
}
