import { test } from 'node:test';
import assert from 'node:assert/strict';

import { executeTools, type ExecDeps } from '../../../src/kernel/executor.ts';
import { ToolRegistry } from '../../../src/tools/registry.ts';
import { defineTool } from '../../../src/tools/spec.ts';
import { RwGate } from '../../../src/tools/gate.ts';
import { MessageBudget, DEFAULT_BUDGET } from '../../../src/tools/budget.ts';
import { FileState } from '../../../src/context/filestate.ts';
import { createEngine } from '../../../src/permissions/engine.ts';
import { ModelFacingError } from '../../../src/kernel/errors.ts';
import type { PendingCall } from '../../../src/kernel/state.ts';
import type { LoopEvent } from '../../../src/kernel/events.ts';

function readTool(name: string, fn: (input: unknown) => Promise<string> | string) {
  return defineTool({
    name,
    description: `read tool ${name}`,
    schema: { type: 'object' },
    concurrencySafe: () => true,
    permissionKey: () => ({ tool: name, action: 'read' }),
    run: async (input) => ({ content: await fn(input) }),
  });
}

function writeTool(name: string, fn: (input: unknown) => Promise<string> | string) {
  return defineTool({
    name,
    description: `write tool ${name}`,
    schema: { type: 'object' },
    concurrencySafe: () => false,
    permissionKey: () => ({ tool: name, action: 'write' }),
    run: async (input) => ({ content: await fn(input) }),
  });
}

function makeDeps(registry: ToolRegistry, mode: 'default' | 'bypass' = 'bypass'): ExecDeps {
  const engine = createEngine({ workspace: '/work', mode, rules: [] });
  return {
    registry,
    engine,
    gate: new RwGate(),
    budget: new MessageBudget(DEFAULT_BUDGET),
    ctx: { cwd: '/work', signal: new AbortController().signal, files: new FileState() },
  };
}

function call(callId: string, name: string, input: unknown = {}): PendingCall {
  return { callId, name, input };
}

// Drive the generator to completion, collecting events and the return value.
async function drive(
  gen: AsyncGenerator<LoopEvent, unknown>,
  onAsk?: (ev: Extract<LoopEvent, { t: 'ask' }>) => void,
): Promise<{ events: LoopEvent[]; result: unknown }> {
  const events: LoopEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    if (step.value.t === 'ask' && onAsk) onAsk(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

test('a single allowed tool emits tool_start then tool_end and returns its result', async () => {
  const reg = new ToolRegistry();
  reg.register(readTool('echo', (i) => `echoed:${JSON.stringify(i)}`));
  const { events, result } = await drive(executeTools([call('c1', 'echo', { x: 1 })], makeDeps(reg)));

  assert.deepEqual(events, [
    { t: 'tool_start', callId: 'c1', name: 'echo', input: { x: 1 } },
    { t: 'tool_end', callId: 'c1', ok: true },
  ]);
  assert.deepEqual(result, [{ callId: 'c1', ok: true, content: 'echoed:{"x":1}' }]);
});

test('an unknown tool becomes a model-facing failed result, not a crash', async () => {
  const reg = new ToolRegistry();
  const { events, result } = await drive(executeTools([call('c1', 'ghost')], makeDeps(reg)));
  const end = events.find((e) => e.t === 'tool_end');
  assert.equal(end?.t === 'tool_end' && end.ok, false);
  assert.equal((result as { ok: boolean }[])[0]!.ok, false);
  assert.match((result as { content: string }[])[0]!.content, /ghost|unknown/i);
});

test('invalid input fails the call before run(), with a repairable message', async () => {
  const reg = new ToolRegistry();
  reg.register(
    defineTool({
      name: 'strict',
      description: 'needs a string field',
      schema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      concurrencySafe: () => true,
      permissionKey: () => ({ tool: 'strict', action: 'read' }),
      run: async () => ({ content: 'ran' }),
    }),
  );
  const { result } = await drive(executeTools([call('c1', 'strict', {})], makeDeps(reg)));
  const r = (result as { ok: boolean; content: string }[])[0]!;
  assert.equal(r.ok, false);
  assert.match(r.content, /invalid input|q/i);
});

test('a tool that throws ModelFacingError yields ok:false carrying its modelText', async () => {
  const reg = new ToolRegistry();
  reg.register(
    readTool('boom', () => {
      throw new ModelFacingError('file not found: /x');
    }),
  );
  const { result } = await drive(executeTools([call('c1', 'boom')], makeDeps(reg)));
  const r = (result as { ok: boolean; content: string }[])[0]!;
  assert.equal(r.ok, false);
  assert.equal(r.content, 'file not found: /x');
});

test('a denied permission yields a failed result naming the denial (default mode, no rules)', async () => {
  const reg = new ToolRegistry();
  reg.register(writeTool('danger', () => 'did it'));
  // default mode + a write with no allow rule ⇒ would ask; deny it via the ask answer
  const deps = makeDeps(reg, 'default');
  const { result } = await drive(executeTools([call('c1', 'danger')], deps), (ev) => {
    deps.engine.broker.settle(ev.askId, 'deny');
  });
  const r = (result as { ok: boolean; content: string }[])[0]!;
  assert.equal(r.ok, false);
  assert.match(r.content, /denied|permission/i);
});

test('an ask answered allow proceeds to run the tool', async () => {
  const reg = new ToolRegistry();
  reg.register(writeTool('danger', () => 'did it'));
  const deps = makeDeps(reg, 'default');
  const { events, result } = await drive(executeTools([call('c1', 'danger')], deps), (ev) => {
    deps.engine.broker.settle(ev.askId, 'allow');
  });
  assert.ok(events.some((e) => e.t === 'ask'));
  assert.deepEqual(result, [{ callId: 'c1', ok: true, content: 'did it' }]);
});

test('concurrency-safe reads run in parallel; a write runs exclusively', async () => {
  const reg = new ToolRegistry();
  let active = 0;
  let maxActive = 0;
  let writeOverlap = false;
  let writeActive = false;
  const track = async (ms: number): Promise<string> => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, ms));
    active--;
    return 'ok';
  };
  reg.register(readTool('r1', () => track(20)));
  reg.register(readTool('r2', () => track(20)));
  reg.register(
    writeTool('w1', async () => {
      if (active > 0) writeOverlap = true;
      writeActive = true;
      await new Promise((r) => setTimeout(r, 10));
      writeActive = false;
      return 'wrote';
    }),
  );
  reg.register(
    readTool('r3', async () => {
      if (writeActive) writeOverlap = true;
      return track(20) as unknown as string;
    }),
  );

  const calls = [call('a', 'r1'), call('b', 'r2'), call('c', 'w1'), call('d', 'r3')];
  const { result } = await drive(executeTools(calls, makeDeps(reg)));
  assert.equal((result as unknown[]).length, 4);
  assert.ok(maxActive >= 2, 'two reads overlapped');
  assert.equal(writeOverlap, false, 'the write never overlapped a read');
});

test('results preserve call order regardless of completion order', async () => {
  const reg = new ToolRegistry();
  reg.register(readTool('slow', async () => {
    await new Promise((r) => setTimeout(r, 30));
    return 'slow-done';
  }));
  reg.register(readTool('fast', async () => 'fast-done'));
  const { result } = await drive(executeTools([call('c1', 'slow'), call('c2', 'fast')], makeDeps(reg)));
  assert.deepEqual(
    (result as { callId: string }[]).map((r) => r.callId),
    ['c1', 'c2'],
  );
});

test('oversized output is budget-fitted in the result content', async () => {
  const reg = new ToolRegistry();
  const huge = 'x'.repeat(50_000);
  reg.register(readTool('big', () => huge));
  const deps = makeDeps(reg);
  deps.budget = new MessageBudget({ perToolChars: 1000, perMessageChars: 5000 });
  const { result } = await drive(executeTools([call('c1', 'big')], deps));
  const r = (result as { content: string }[])[0]!;
  assert.ok(r.content.length <= 1000);
  assert.match(r.content, /omitted/);
});
