// P9 spawn: the child-session primitive (DESIGN §9). A child runs a delegated
// task to completion under narrowed grants and returns a structured result the
// orchestrator injects as a <task-notification> user message. CacheSafeParams
// is the cache-coherence contract — a frozen, byte-stable struct so a child's
// model calls latch the prompt cache. The spawner enforces a depth cap (a
// child cannot itself spawn at depth>=max) and a sibling concurrency cap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheSafeParams,
  createSpawner,
  taskNotification,
  type SpawnSpec,
  type ChildResult,
} from '../../../src/agents/spawn.ts';
import { isModelFacing } from '../../../src/kernel/errors.ts';

test('cacheSafeParams is frozen and byte-stable for identical inputs', () => {
  const a = cacheSafeParams({ model: 'claude-fable-5', systemHash: 'sys1', toolListHash: 'tl1' });
  const b = cacheSafeParams({ model: 'claude-fable-5', systemHash: 'sys1', toolListHash: 'tl1' });
  assert.ok(Object.isFrozen(a));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.throws(() => {
    (a as { model: string }).model = 'other';
  });
});

test('taskNotification renders task-notification XML with name and status', () => {
  const xml = taskNotification({ name: 'researcher', status: 'ok', content: 'found 3 results' });
  assert.match(xml, /<task-notification name="researcher" status="ok">/);
  assert.match(xml, /found 3 results/);
  assert.match(xml, /<\/task-notification>/);
});

function spec(name: string, prompt: string, depth = 0): SpawnSpec {
  return { name, prompt, depth, grants: ['read'] };
}

test('spawn runs the child and returns its result', async () => {
  const spawner = createSpawner({
    maxDepth: 1,
    maxConcurrency: 4,
    runChild: async (s) => ({ name: s.name, status: 'ok', content: `did: ${s.prompt}` }),
  });
  const result = await spawner.spawn(spec('worker', 'summarize'));
  assert.deepEqual(result, { name: 'worker', status: 'ok', content: 'did: summarize' });
});

test('spawn refuses past the depth cap with a model-facing error', async () => {
  const spawner = createSpawner({
    maxDepth: 1,
    maxConcurrency: 4,
    runChild: async () => ({ name: 'x', status: 'ok', content: '' }),
  });
  // depth 1 == maxDepth → a child at this depth cannot spawn another
  await assert.rejects(spawner.spawn(spec('deep', 'p', 1)), (err: unknown) => {
    assert.ok(isModelFacing(err));
    assert.match((err as Error).message, /depth/i);
    return true;
  });
});

test('spawn caps sibling concurrency: never more than maxConcurrency run at once', async () => {
  let active = 0;
  let peak = 0;
  const spawner = createSpawner({
    maxDepth: 2,
    maxConcurrency: 2,
    runChild: async (s) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
      return { name: s.name, status: 'ok', content: '' } satisfies ChildResult;
    },
  });
  await Promise.all([
    spawner.spawn(spec('a', 'p')),
    spawner.spawn(spec('b', 'p')),
    spawner.spawn(spec('c', 'p')),
    spawner.spawn(spec('d', 'p')),
  ]);
  assert.ok(peak <= 2, `peak concurrency ${peak} exceeded cap 2`);
});

test('spawn maps a child failure to an error result, not a throw', async () => {
  const spawner = createSpawner({
    maxDepth: 1,
    maxConcurrency: 4,
    runChild: async () => {
      throw new Error('child crashed');
    },
  });
  const result = await spawner.spawn(spec('boom', 'p'));
  assert.equal(result.status, 'error');
  assert.match(result.content, /child crashed/);
});

test('spawn builds child cache params once; identical specs yield byte-stable params', async () => {
  const seen: string[] = [];
  const spawner = createSpawner({
    maxDepth: 1,
    maxConcurrency: 4,
    cacheParamsFor: (s) => cacheSafeParams({ model: 'm', systemHash: `sys:${s.name}`, toolListHash: 'tl' }),
    runChild: async (s, params) => {
      seen.push(JSON.stringify(params));
      return { name: s.name, status: 'ok', content: '' };
    },
  });
  await spawner.spawn(spec('w', 'p'));
  await spawner.spawn(spec('w', 'p'));
  assert.equal(seen[0], seen[1]); // byte-stable across identical specs
});
