// P9 agent tool (DESIGN §9): the model-facing spawn surface. It wraps a
// Spawner. In await mode it runs the delegated child to completion and returns
// its <task-notification> as the tool result, ready for the orchestrator to
// fold into history (the notification survives compaction). In detached mode
// it registers the task on the board, runs the child in the background, and
// records the result on completion — returning the task id immediately so the
// orchestrator can keep working and poll the board later.
//
// Spawning is execute-class and never concurrency-safe: a delegate can do
// anything its grants allow, so it routes through the gate serially.

import { ModelFacingError } from '../../kernel/errors.ts';
import { newId } from '../../lib/ids.ts';
import { defineTool } from '../spec.ts';
import type { ToolSpec } from '../spec.ts';
import type { Spawner, SpawnSpec } from '../../agents/spawn.ts';
import { taskNotification } from '../../agents/spawn.ts';
import type { Board } from '../../agents/board.ts';

export interface AgentIn {
  readonly prompt: string;
  readonly name?: string;
  readonly detached?: boolean;
}

export interface AgentToolDeps {
  readonly spawner: Spawner;
  /** Depth of the session hosting this tool; the spawner caps depth>=maxDepth. */
  readonly depth: number;
  /** Tool grants handed to children (a subset of the parent's surface). */
  readonly grants: readonly string[];
  /** Required for detached spawns; the coordination board. */
  readonly board?: Board;
}

export function makeAgentTool(deps: AgentToolDeps): ToolSpec<AgentIn> {
  return defineTool<AgentIn>({
    name: 'agent',
    description:
      'Spawn a subagent to handle a delegated task. By default the call awaits the ' +
      'subagent and returns its result; pass detached:true to run it in the background ' +
      'and get a task id back immediately.',
    schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task for the subagent' },
        name: { type: 'string', description: 'A short label for the subagent (e.g. "researcher")' },
        detached: { type: 'boolean', description: 'Run in the background instead of awaiting' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    exposure: 'direct',
    concurrencySafe: () => false,
    permissionKey: (input) => ({ tool: 'agent', action: 'execute', target: input.name ?? 'subagent' }),
    run: async (input) => {
      const spec: SpawnSpec = {
        name: input.name ?? 'subagent',
        prompt: input.prompt,
        depth: deps.depth,
        grants: deps.grants,
      };

      if (input.detached === true) {
        const board = deps.board;
        if (!board) {
          throw new ModelFacingError('detached spawns require a task board, which is not available in this session');
        }
        const taskId = `task-${newId()}`;
        board.add(taskId);
        board.claim(taskId, spec.name);
        // Fire-and-forget: record the outcome on the board when the child settles.
        void deps.spawner.spawn(spec).then(
          (result) => board.complete(taskId, spec.name, result.content),
          (err) => board.complete(taskId, spec.name, err instanceof Error ? err.message : String(err)),
        );
        return {
          content: `Spawned "${spec.name}" in the background. task id: ${taskId}`,
          uiData: { taskId, name: spec.name },
        };
      }

      const result = await deps.spawner.spawn(spec);
      return { content: taskNotification(result), uiData: { name: result.name, status: result.status } };
    },
  });
}
