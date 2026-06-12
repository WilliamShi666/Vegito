// P9 agent tool: the model-facing spawn surface (DESIGN §9). It wraps the
// Spawner: in await mode it runs the child to completion and returns the
// <task-notification> as the tool result; in detached mode it registers the
// task on the board, runs the child in the background, records the result on
// completion, and returns immediately with the task id. The tool is no longer
// hidden — P9 turns it on.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { makeAgentTool } from '../../../../src/tools/builtin/agent.ts';
import { createSpawner } from '../../../../src/agents/spawn.ts';
import { createBoard } from '../../../../src/agents/board.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

const ctx = mkCtx('/tmp');

describe('agent builtin (P9 orchestrator)', () => {
  test('is direct (advertised), execute-class, not concurrency-safe', () => {
    const spawner = createSpawner({
      maxDepth: 1,
      maxConcurrency: 4,
      runChild: async (s) => ({ name: s.name, status: 'ok', content: '' }),
    });
    const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'] });
    assert.equal(tool.exposure, 'direct');
    assert.equal(tool.permissionKey({ prompt: 'p', name: 'w' }).action, 'execute');
    assert.equal(tool.concurrencySafe({ prompt: 'p', name: 'w' }), false);
  });

  test('await mode runs the child and returns a task-notification', async () => {
    const spawner = createSpawner({
      maxDepth: 1,
      maxConcurrency: 4,
      runChild: async (s) => ({ name: s.name, status: 'ok', content: `result for ${s.prompt}` }),
    });
    const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'] });
    const out = await tool.run({ prompt: 'summarize the repo', name: 'researcher' }, ctx);
    assert.match(out.content, /<task-notification name="researcher" status="ok">/);
    assert.match(out.content, /result for summarize the repo/);
  });

  test('await mode surfaces a failed child as status="error"', async () => {
    const spawner = createSpawner({
      maxDepth: 1,
      maxConcurrency: 4,
      runChild: async () => {
        throw new Error('boom');
      },
    });
    const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'] });
    const out = await tool.run({ prompt: 'p', name: 'w' }, ctx);
    assert.match(out.content, /status="error"/);
    assert.match(out.content, /boom/);
  });

  test('detached mode registers the task on the board and returns its id immediately', async () => {
    const board = createBoard();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const spawner = createSpawner({
      maxDepth: 1,
      maxConcurrency: 4,
      runChild: async (s) => {
        await gate;
        return { name: s.name, status: 'ok', content: 'done-payload' };
      },
    });
    const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'], board });
    const out = await tool.run({ prompt: 'long task', name: 'bg', detached: true }, ctx);
    const m = /task id: (\S+)/.exec(out.content);
    assert.ok(m, 'detached result should carry a task id');
    const taskId = m![1]!;
    assert.equal(board.get(taskId)?.status, 'claimed');
    release!();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(board.get(taskId)?.status, 'done');
    assert.equal(board.get(taskId)?.result, 'done-payload');
  });

  test('detached mode without a board is a model-facing error', async () => {
    const spawner = createSpawner({
      maxDepth: 1,
      maxConcurrency: 4,
      runChild: async (s) => ({ name: s.name, status: 'ok', content: '' }),
    });
    const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'] });
    await assert.rejects(tool.run({ prompt: 'p', name: 'w', detached: true }, ctx), /detached|board/i);
  });
});
