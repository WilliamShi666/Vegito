// P10 composition root (DESIGN §11): assembleLoopDeps turns a model-call seam
// plus the session environment into the kernel's LoopDeps. Both UI surfaces
// (repl, headless) and the offline test path share it, so the wire is injected
// — live wires for `vegito run`, the ScriptedWire for tests and forge offline.
// The point of the seam is that the whole agent is drivable without a network.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { assembleLoopDeps } from '../../../src/ui/runtime.ts';
import { initialState } from '../../../src/kernel/state.ts';
import { reduce } from '../../../src/kernel/reducer.ts';
import { runTurn } from '../../../src/kernel/loop.ts';
import { ToolRegistry } from '../../../src/tools/registry.ts';
import { defineTool } from '../../../src/tools/spec.ts';
import { ScriptedWire } from '../../../src/providers/wire/scripted.ts';
import type { LoopEvent, ExitReason } from '../../../src/kernel/events.ts';
import type { Usage } from '../../../src/providers/types.ts';

const U: Usage = { in: 4, out: 2, cacheRead: 0, cacheWrite: 0 };

function registryWith(...specs: Parameters<ToolRegistry['register']>[0][]): ToolRegistry {
  const reg = new ToolRegistry();
  for (const s of specs) reg.register(s);
  return reg;
}

async function drive(state: ReturnType<typeof initialState>, deps: ReturnType<typeof assembleLoopDeps>) {
  const events: LoopEvent[] = [];
  const gen = runTurn(state, deps);
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, reason: step.value.reason as ExitReason, state: step.value.state };
}

describe('assembleLoopDeps', () => {
  test('drives a one-shot answer turn end to end over the scripted wire', async () => {
    const wire = new ScriptedWire([
      { kind: 'events', events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'text_delta', text: 'hi there' },
        { t: 'msg_end', stop: 'end_turn', usage: U },
      ] },
    ]);
    const deps = assembleLoopDeps({
      providerName: 'scripted',
      callModel: (req, sig) => wire.send(req, sig),
      registry: new ToolRegistry(),
      workspace: '/work',
      mode: 'bypass',
      systemTiers: ['identity', 'env'],
      config: { model: 'scripted-1', maxIterations: 10, permissionMode: 'bypass', trace: false },
      signal: new AbortController().signal,
    });

    let s = initialState({ sid: 's', model: 'scripted-1', maxIterations: 10 });
    s = reduce(s, { t: 'user_msg', blocks: [{ kind: 'text', text: 'hello' }] });
    const { events, reason } = await drive(s, deps);

    assert.equal(reason, 'end_turn');
    assert.ok(events.some((e) => e.t === 'text_delta' && /hi there/.test(e.text)));
  });

  test('assembleRequest advertises the registry tools and freezes the system tiers', async () => {
    const wire = new ScriptedWire([
      { kind: 'events', events: [
        { t: 'msg_start', model: 'm' },
        { t: 'text_delta', text: 'done' },
        { t: 'msg_end', stop: 'end_turn', usage: U },
      ] },
    ]);
    const reg = registryWith(
      defineTool({
        name: 'peek',
        description: 'peek at a file',
        schema: { type: 'object', properties: { p: { type: 'string' } } },
        concurrencySafe: () => true,
        permissionKey: () => ({ tool: 'peek', action: 'read' }),
        run: async () => ({ content: 'x' }),
      }),
    );
    const deps = assembleLoopDeps({
      providerName: 'scripted',
      callModel: (req, sig) => wire.send(req, sig),
      registry: reg,
      workspace: '/work',
      mode: 'bypass',
      systemTiers: ['T1', 'T2'],
      config: { model: 'm', maxIterations: 5, permissionMode: 'bypass', trace: false },
      signal: new AbortController().signal,
    });

    let s = initialState({ sid: 's', model: 'm', maxIterations: 5 });
    s = reduce(s, { t: 'user_msg', blocks: [{ kind: 'text', text: 'go' }] });
    const req = deps.assembleRequest(s);
    assert.deepEqual([...req.system], ['T1', 'T2']);
    assert.equal(req.tools.length, 1);
    assert.equal(req.tools[0]!.name, 'peek');
    assert.equal(req.tools[0]!.description, 'peek at a file');
    assert.ok(req.maxTokens > 0);
  });

  test('builds a permission engine honoring the requested mode (plan blocks writes)', async () => {
    const deps = assembleLoopDeps({
      providerName: 'scripted',
      callModel: () => (async function* () {})(),
      registry: new ToolRegistry(),
      workspace: '/work',
      mode: 'plan',
      systemTiers: ['id'],
      config: { model: 'm', maxIterations: 5, permissionMode: 'plan', trace: false },
      signal: new AbortController().signal,
    });
    const verdict = await deps.exec.engine.check({ tool: 'write', action: 'write', target: '/work/a.ts' });
    assert.equal(verdict, 'deny');
  });

  test('threads a hook bus into the executor: a PreToolUse block stops the tool mid-turn', async () => {
    const wire = new ScriptedWire([
      { kind: 'events', events: [
        { t: 'msg_start', model: 'm' },
        { t: 'tool_call', callId: 'c1', name: 'touchy', input: {} },
        { t: 'msg_end', stop: 'tool_use', usage: U },
      ] },
      { kind: 'events', events: [
        { t: 'msg_start', model: 'm' },
        { t: 'text_delta', text: 'understood' },
        { t: 'msg_end', stop: 'end_turn', usage: U },
      ] },
    ]);
    let ran = false;
    const reg = registryWith(
      defineTool({
        name: 'touchy',
        description: 'a tool the hook forbids',
        schema: { type: 'object', properties: {} },
        concurrencySafe: () => true,
        permissionKey: () => ({ tool: 'touchy', action: 'read' }),
        run: async () => {
          ran = true;
          return { content: 'touched' };
        },
      }),
    );
    const bus: import('../../../src/extend/hooks.ts').HookBus = {
      dispatch: async (event) =>
        event === 'PreToolUse'
          ? { decision: 'block', contexts: [], messages: ['frozen by policy hook'] }
          : { decision: 'allow', contexts: [], messages: [] },
    };
    const deps = assembleLoopDeps({
      providerName: 'scripted',
      callModel: (req, sig) => wire.send(req, sig),
      registry: reg,
      workspace: '/work',
      mode: 'bypass',
      systemTiers: ['id'],
      config: { model: 'm', maxIterations: 5, permissionMode: 'bypass', trace: false },
      signal: new AbortController().signal,
      hooks: bus,
    });

    let s = initialState({ sid: 's', model: 'm', maxIterations: 5 });
    s = reduce(s, { t: 'user_msg', blocks: [{ kind: 'text', text: 'touch it' }] });
    const { reason } = await drive(s, deps);

    assert.equal(reason, 'end_turn');
    assert.equal(ran, false, 'the tool must not run when the hook blocks');
    // The block reason went back to the model as the tool result.
    assert.equal(wire.calls.length, 2);
    assert.ok(JSON.stringify(wire.calls[1]!.messages).includes('frozen by policy hook'));
  });
});
