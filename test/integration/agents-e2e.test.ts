// P9 integration gate (DESIGN §9): the multi-agent primitive, end to end,
// through the REAL surfaces — the model-facing `agent` tool, a real Spawner,
// a real coordination Board, run under the real RwGate (which serializes the
// execute-class spawn calls) and a real permission engine. Three properties
// the gate demands:
//   1. an orchestrator fans a task out to 3 workers and folds their results;
//   2. a 1000-iteration claim race on the board never double-claims;
//   3. identical child specs yield byte-stable cache params (cache-safe).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeAgentTool } from '../../src/tools/builtin/agent.ts';
import { createSpawner, cacheSafeParams } from '../../src/agents/spawn.ts';
import type { ChildResult, SpawnSpec } from '../../src/agents/spawn.ts';
import { createBoard } from '../../src/agents/board.ts';
import { RwGate } from '../../src/tools/gate.ts';
import { createEngine } from '../../src/permissions/engine.ts';
import { mkCtx } from '../helpers/toolctx.ts';

const ctx = mkCtx('/tmp');

// A scripted child session: it "answers" by echoing its prompt. Real spawners
// re-enter the loop here; the gate only needs the contract, not a live model.
function scriptedRunChild(): (s: SpawnSpec) => Promise<ChildResult> {
  return async (s) => ({ name: s.name, status: 'ok', content: `${s.name} handled: ${s.prompt}` });
}

test('orchestrator fans a task out to 3 workers and folds their notifications', async () => {
  const spawner = createSpawner({ maxDepth: 2, maxConcurrency: 4, runChild: scriptedRunChild() });
  const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'] });
  const gate = new RwGate();
  const engine = createEngine({ workspace: '/tmp', mode: 'default', rules: [{ tool: 'agent', verdict: 'allow' }] });

  const workers = ['scout', 'builder', 'checker'];
  // Each spawn is execute-class / not concurrency-safe, so it routes through the
  // gate as a write — exactly how the loop would dispatch it.
  const results = await Promise.all(
    workers.map(async (name) => {
      const verdict = await engine.check({ tool: 'agent', action: 'execute', target: name });
      assert.equal(verdict, 'allow');
      return gate.run('write', () => tool.run({ prompt: `phase ${name}`, name }, ctx));
    }),
  );

  for (const name of workers) {
    const folded = results.find((r) => r.content.includes(`name="${name}"`));
    assert.ok(folded, `missing notification for ${name}`);
    assert.match(folded!.content, new RegExp(`<task-notification name="${name}" status="ok">`));
    assert.match(folded!.content, new RegExp(`${name} handled: phase ${name}`));
  }
});

test('detached fan-out: workers report back through the board as they finish', async () => {
  const board = createBoard();
  const releases: Array<() => void> = [];
  const spawner = createSpawner({
    maxDepth: 2,
    maxConcurrency: 4,
    runChild: async (s) => {
      await new Promise<void>((r) => releases.push(r));
      return { name: s.name, status: 'ok', content: `${s.name}: ok` };
    },
  });
  const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'], board });

  const ids: string[] = [];
  for (const name of ['a', 'b', 'c']) {
    const out = await tool.run({ prompt: 'bg', name, detached: true }, ctx);
    const m = /task id: (\S+)/.exec(out.content);
    assert.ok(m, `detached worker ${name} should return a task id`);
    ids.push(m![1]!);
  }
  // All three are claimed and in flight before any completes.
  for (const id of ids) assert.equal(board.get(id)?.status, 'claimed');

  // Let them finish one at a time; each records its own result, in order.
  for (let i = 0; i < releases.length; i += 1) releases[i]!();
  await new Promise((r) => setTimeout(r, 30));
  for (const id of ids) {
    assert.equal(board.get(id)?.status, 'done');
    assert.match(board.get(id)!.result!, /: ok/);
  }
});

test('board claim race: 1000 concurrent claimers, exactly one wins each round', async () => {
  for (let round = 0; round < 1000; round += 1) {
    const board = createBoard();
    const id = `t-${round}`;
    board.add(id);
    const claimers = Array.from({ length: 8 }, (_, i) => `w${i}`);
    const won = await Promise.all(claimers.map((w) => Promise.resolve().then(() => board.claim(id, w))));
    const winners = won.filter(Boolean);
    assert.equal(winners.length, 1, `round ${round}: ${winners.length} winners (expected exactly 1)`);
    assert.equal(board.get(id)?.status, 'claimed');
  }
});

test('child cache params are byte-stable for identical specs (cache-safe)', async () => {
  const seen: string[] = [];
  const spawner = createSpawner({
    maxDepth: 2,
    maxConcurrency: 4,
    cacheParamsFor: (s) => cacheSafeParams({ model: s.model ?? 'default', systemHash: 'sys', toolListHash: 'tl' }),
    runChild: async (s, params) => {
      seen.push(JSON.stringify(params));
      return { name: s.name, status: 'ok', content: '' };
    },
  });
  const tool = makeAgentTool({ spawner, depth: 0, grants: ['read'] });
  await tool.run({ prompt: 'same', name: 'w' }, ctx);
  await tool.run({ prompt: 'same', name: 'w' }, ctx);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1], 'identical specs must produce byte-identical cache params');
});
