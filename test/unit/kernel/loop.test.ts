import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTurn, type LoopDeps } from '../../../src/kernel/loop.ts';
import { initialState, reduce, type SessionState } from '../../../src/kernel/index.ts';
import { createRecoverer, retryAfterStrategy } from '../../../src/kernel/recovery.ts';
import { ToolRegistry } from '../../../src/tools/registry.ts';
import { defineTool } from '../../../src/tools/spec.ts';
import { RwGate } from '../../../src/tools/gate.ts';
import { MessageBudget, DEFAULT_BUDGET } from '../../../src/tools/budget.ts';
import { FileState } from '../../../src/context/filestate.ts';
import { createEngine } from '../../../src/permissions/engine.ts';
import { ProviderHttpError } from '../../../src/providers/errors.ts';
import type { ProviderEvent, NeutralRequest, Usage } from '../../../src/providers/types.ts';
import type { LoopEvent } from '../../../src/kernel/events.ts';

const USAGE: Usage = { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 };

function textResponse(text: string): ProviderEvent[] {
  return [
    { t: 'msg_start', model: 'test' },
    { t: 'text_delta', text },
    { t: 'msg_end', stop: 'end_turn', usage: USAGE },
  ];
}

function toolResponse(callId: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { t: 'msg_start', model: 'test' },
    { t: 'tool_call', callId, name, input },
    { t: 'msg_end', stop: 'tool_use', usage: USAGE },
  ];
}

// A scripted model: each entry is either a list of events to stream, or an
// error to throw (after optionally streaming a prefix).
type Script = Array<ProviderEvent[] | { throw: unknown }>;

function scriptedModel(script: Script): {
  call: (req: NeutralRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>;
  attempts: () => number;
} {
  let i = 0;
  return {
    attempts: () => i,
    call(_req, _signal): AsyncIterable<ProviderEvent> {
      const entry = script[i++];
      return {
        async *[Symbol.asyncIterator]() {
          if (entry === undefined) throw new Error('script exhausted');
          if (Array.isArray(entry)) {
            for (const ev of entry) yield ev;
          } else {
            throw entry.throw;
          }
        },
      };
    },
  };
}

function makeExec(registry: ToolRegistry, mode: 'default' | 'bypass' = 'bypass') {
  return {
    registry,
    engine: createEngine({ workspace: '/work', mode, rules: [] }),
    gate: new RwGate(),
    budget: new MessageBudget(DEFAULT_BUDGET),
    ctx: { cwd: '/work', signal: new AbortController().signal, files: new FileState() },
  };
}

function startState(): SessionState {
  const s = initialState({ sid: 's1', model: 'test', maxIterations: 10 });
  return reduce(s, { t: 'user_msg', blocks: [{ kind: 'text', text: 'hello' }] });
}

function baseDeps(script: Script, registry: ToolRegistry): LoopDeps & { _model: ReturnType<typeof scriptedModel> } {
  const model = scriptedModel(script);
  return {
    _model: model,
    providerName: 'test',
    assembleRequest: (s) => ({
      model: s.model,
      system: ['sys'],
      messages: s.history,
      tools: [],
      maxTokens: 1024,
    }),
    callModel: model.call,
    exec: makeExec(registry),
    recoverer: createRecoverer([]),
    signal: new AbortController().signal,
    maxAttempts: 4,
  };
}

async function run(
  state: SessionState,
  deps: LoopDeps,
): Promise<{ events: LoopEvent[]; result: { state: SessionState; reason: string } }> {
  const events: LoopEvent[] = [];
  const gen = runTurn(state, deps);
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value as { state: SessionState; reason: string } };
}

test('plain answer: one model call, no tools, ends with end_turn', async () => {
  const { events, result } = await run(startState(), baseDeps([textResponse('hi there')], new ToolRegistry()));
  assert.equal(result.reason, 'end_turn');
  assert.equal(events[0]!.t, 'turn_start');
  assert.ok(events.some((e) => e.t === 'text_delta' && e.text === 'hi there'));
  const end = events.at(-1)!;
  assert.equal(end.t, 'turn_end');
  assert.equal(end.t === 'turn_end' && end.reason, 'end_turn');
  // the assistant message landed in history
  const last = result.state.history.at(-1)!;
  assert.equal(last.role, 'assistant');
  assert.equal(result.state.usage.out, 5);
});

test('three-step tool loop: model calls a tool, sees the result, then answers', async () => {
  const reg = new ToolRegistry();
  reg.register(
    defineTool({
      name: 'clock',
      description: 'returns a fixed time',
      schema: { type: 'object' },
      concurrencySafe: () => true,
      permissionKey: () => ({ tool: 'clock', action: 'read' }),
      run: async () => ({ content: '12:00' }),
    }),
  );
  const deps = baseDeps(
    [toolResponse('c1', 'clock', {}), textResponse('it is 12:00')],
    reg,
  );
  const { events, result } = await run(startState(), deps);
  assert.equal(result.reason, 'end_turn');
  assert.ok(events.some((e) => e.t === 'tool_start' && e.name === 'clock'));
  assert.ok(events.some((e) => e.t === 'tool_end' && e.ok === true));
  assert.ok(events.some((e) => e.t === 'text_delta' && e.text === 'it is 12:00'));
  // history: user, assistant(tool_call), user(tool_result), assistant(text)
  assert.equal(result.state.history.length, 4);
  const toolResult = result.state.history[2]!;
  assert.equal(toolResult.blocks[0]!.kind, 'tool_result');
  assert.equal(deps._model.attempts(), 2);
});

test('recovery: a retryable error is recovered and the turn completes without scarring history', async () => {
  const slept: number[] = [];
  const deps = baseDeps(
    [{ throw: new ProviderHttpError(503, 'unavailable', { retryAfterMs: 100 }) }, textResponse('recovered')],
    new ToolRegistry(),
  );
  deps.recoverer = createRecoverer([retryAfterStrategy({ sleep: async (ms) => void slept.push(ms) })]);
  const { events, result } = await run(startState(), deps);
  assert.equal(result.reason, 'end_turn');
  assert.deepEqual(slept, [100]);
  assert.ok(events.some((e) => e.t === 'text_delta' && e.text === 'recovered'));
  // no error message was appended; history is clean (user + one assistant)
  assert.equal(result.state.history.length, 2);
  assert.equal(deps._model.attempts(), 2);
});

test('an unrecovered error surfaces and ends the turn as fatal_error', async () => {
  const deps = baseDeps([{ throw: new ProviderHttpError(400, 'bad request', {}) }], new ToolRegistry());
  deps.recoverer = createRecoverer([retryAfterStrategy({ sleep: async () => {} })]);
  const { result } = await run(startState(), deps);
  assert.equal(result.reason, 'fatal_error');
});

test('maxIterations is a hard ceiling against an infinite tool loop', async () => {
  const reg = new ToolRegistry();
  reg.register(
    defineTool({
      name: 'loop',
      description: 'always asks to be called again',
      schema: { type: 'object' },
      concurrencySafe: () => true,
      permissionKey: () => ({ tool: 'loop', action: 'read' }),
      run: async () => ({ content: 'again' }),
    }),
  );
  // a model that forever requests the tool
  const script: Script = Array.from({ length: 20 }, (_v, i) => toolResponse(`c${i}`, 'loop', {}));
  const s = initialState({ sid: 's', model: 'test', maxIterations: 3 });
  const deps = baseDeps(script, reg);
  const { result } = await run(reduce(s, { t: 'user_msg', blocks: [{ kind: 'text', text: 'go' }] }), deps);
  assert.equal(result.reason, 'max_iterations');
});

test('an aborted signal ends the turn as interrupted', async () => {
  const ac = new AbortController();
  const deps = baseDeps([{ throw: new Error('aborted mid-stream') }], new ToolRegistry());
  deps.signal = ac.signal;
  ac.abort();
  const { result } = await run(startState(), deps);
  assert.equal(result.reason, 'interrupted');
});

test('every emitted event is JSON-serializable (D11)', async () => {
  const reg = new ToolRegistry();
  reg.register(
    defineTool({
      name: 'clock',
      description: 'time',
      schema: { type: 'object' },
      concurrencySafe: () => true,
      permissionKey: () => ({ tool: 'clock', action: 'read' }),
      run: async () => ({ content: 'now' }),
    }),
  );
  const { events } = await run(startState(), baseDeps([toolResponse('c1', 'clock', {}), textResponse('done')], reg));
  for (const ev of events) {
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(ev)));
  }
});
