// todo builtin (DESIGN §7.1): the model's working plan, replace-list semantics
// (cc/01 — full-list writes beat patch ops; the model re-states the whole plan
// each time, so a dropped update cannot corrupt state). Factory-scoped: each
// session owns its own list. Action is 'read' — this mutates only in-process
// harness state, never the user's world, so it must never trigger an ask.

import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';
import type { ToolSpec } from '../spec.ts';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  readonly content: string;
  readonly status: TodoStatus;
}

export interface TodoIn {
  readonly todos: readonly TodoItem[];
}

export interface TodoTool extends ToolSpec<TodoIn> {
  current(): readonly TodoItem[];
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

export function makeTodoTool(): TodoTool {
  let list: readonly TodoItem[] = [];

  const spec = defineTool<TodoIn>({
    name: 'todo',
    description:
      'Replace your task list with the given items. Write the FULL list every time — this is a ' +
      'whole-list replacement, not a patch. Use it to plan multi-step work and show progress.',
    schema: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete new task list (empty array clears it)',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'The task, imperative form' },
              status: { type: 'string', enum: [...STATUSES], description: 'pending | in_progress | completed' },
            },
            required: ['content', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['todos'],
      additionalProperties: false,
    },
    permissionKey: () => ({ tool: 'todo', action: 'read' }),
    run: async (input) => {
      for (const item of input.todos) {
        if (!STATUSES.includes(item.status)) {
          throw new ModelFacingError(
            `invalid todo status ${JSON.stringify(item.status)} — use pending, in_progress, or completed`,
          );
        }
        if (item.content.trim() === '') {
          throw new ModelFacingError('todo content must not be empty');
        }
      }
      list = input.todos.map((t) => ({ content: t.content, status: t.status }));
      const active = list.filter((t) => t.status !== 'completed').length;
      return {
        content: `todo list updated: ${list.length} item${list.length === 1 ? '' : 's'} (${active} open)`,
        uiData: { todos: list },
      };
    },
  });

  return { ...spec, current: () => list };
}
