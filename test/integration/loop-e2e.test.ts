import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runTurn, type LoopDeps } from '../../src/kernel/loop.ts';
import { initialState } from '../../src/kernel/state.ts';
import { reduce } from '../../src/kernel/reducer.ts';
import { createRecoverer, retryAfterStrategy } from '../../src/kernel/recovery.ts';
import { ScriptedWire } from '../../src/providers/wire/scripted.ts';
import { ProviderHttpError } from '../../src/providers/errors.ts';
import { ToolRegistry } from '../../src/tools/registry.ts';
import { defineTool } from '../../src/tools/spec.ts';
import { RwGate } from '../../src/tools/gate.ts';
import { MessageBudget, DEFAULT_BUDGET } from '../../src/tools/budget.ts';
import { FileState } from '../../src/context/filestate.ts';
import { createEngine } from '../../src/permissions/engine.ts';
import { createTranscript } from '../../src/sessions/transcript.ts';
import type { ProviderEvent, Usage } from '../../src/providers/types.ts';
import type { LoopEvent, ExitReason } from '../../src/kernel/events.ts';
import type { ScriptedStep } from '../../src/providers/wire/scripted.ts';

// End-to-end: the REAL loop driving the REAL ScriptedWire, with tool execution
// writing tool_result records into a REAL on-disk transcript. This is the P7
// gate — a multi-tool turn completes headlessly and asserts its ExitReason.

const U: Usage = { in: 12, out: 7, cacheRead: 0, cacheWrite: 0 };

function ev(...events: ProviderEvent[]): ScriptedStep {
  return { kind: 'events', events };
}
function toolCall(callId: string, name: string, input: unknown): ProviderEvent[] {
  return [
    { t: 'msg_start', model: 'scripted-1' },
    { t: 'tool_call', callId, name, input },
    { t: 'msg_end', stop: 'tool_use', usage: U },
  ];
}
function answer(text: string): ProviderEvent[] {
  return [
    { t: 'msg_start', model: 'scripted-1' },
    { t: 'text_delta', text },
    { t: 'msg_end', stop: 'end_turn', usage: U },
  ];
}

function buildDeps(wire: ScriptedWire, registry: ToolRegistry, over: Partial<LoopDeps> = {}): LoopDeps {
  const signal = over.signal ?? new AbortController().signal;
  return {
    providerName: 'scripted',
    assembleRequest: (s) => ({ model: s.model, system: ['identity'], messages: s.history, tools: [], maxTokens: 2048 }),
    callModel: (req, sig) => wire.send(req, sig),
    exec: {
      registry,
      engine: createEngine({ workspace: '/work', mode: 'bypass', rules: [] }),
      gate: new RwGate(),
      budget: new MessageBudget(DEFAULT_BUDGET),
      ctx: { cwd: '/work', signal, files: new FileState() },
    },
    recoverer: createRecoverer([]),
    signal,
    maxAttempts: 4,
    ...over,
  };
}

async function drive(state: ReturnType<typeof initialState>, deps: LoopDeps): Promise<{ events: LoopEvent[]; reason: ExitReason; state: ReturnType<typeof initialState> }> {
  const events: LoopEvent[] = [];
  const gen = runTurn(state, deps);
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, reason: step.value.reason, state: step.value.state };
}

function fileTools(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(
    defineTool({
      name: 'list_files',
      description: 'lists files',
      schema: { type: 'object' },
      concurrencySafe: () => true,
      permissionKey: () => ({ tool: 'list_files', action: 'read' }),
      run: async () => ({ content: 'a.ts\nb.ts\nc.ts' }),
    }),
  );
  reg.register(
    defineTool({
      name: 'count_lines',
      description: 'counts lines in a file',
      schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
      concurrencySafe: () => true,
      permissionKey: (i) => ({ tool: 'count_lines', action: 'read', target: (i as { file: string }).file }),
      run: async (i) => ({ content: `${(i as { file: string }).file}: 42 lines` }),
    }),
  );
  return reg;
}

test('P7 gate: a two-tool turn completes headlessly and appends tool_results to a transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-p7-'));
  try {
    const wire = new ScriptedWire([
      ev(...toolCall('c1', 'list_files', {})),
      ev(...toolCall('c2', 'count_lines', { file: 'a.ts' })),
      ev(...answer('There are 3 files; a.ts has 42 lines.')),
    ]);
    const reg = fileTools();
    const transcriptFile = join(dir, 'sess.jsonl');
    const transcript = await createTranscript(transcriptFile, { sid: 'sess', created: 'c', appVersion: '0.1.0' });

    let state = initialState({ sid: 'sess', model: 'scripted-1', maxIterations: 10 });
    state = reduce(state, { t: 'user_msg', blocks: [{ kind: 'text', text: 'analyze the project' }] });
    await transcript.appendMsg(state.history[0]!);

    const deps = buildDeps(wire, reg);
    const { events, reason, state: finalState } = await drive(state, deps);

    assert.equal(reason, 'end_turn');
    // both tools ran
    const toolEnds = events.filter((e) => e.t === 'tool_end');
    assert.equal(toolEnds.length, 2);
    assert.ok(toolEnds.every((e) => e.t === 'tool_end' && e.ok));
    // three model calls happened (tool, tool, answer)
    assert.equal(wire.calls.length, 3);
    // final answer present
    assert.ok(events.some((e) => e.t === 'text_delta' && /42 lines/.test(e.text)));

    // persist the new messages to the transcript and prove replay equals state
    for (const m of finalState.history.slice(1)) await transcript.appendMsg(m);
    const onDisk = (await readFile(transcriptFile, 'utf8')).trim().split('\n');
    assert.ok(onDisk.length >= 5); // header + user + 4 turn messages
    assert.deepEqual(transcript.messages(), finalState.history);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('P7 gate: scripted 503 then success — turn completes, ExitReason end_turn, no scar', async () => {
  const slept: number[] = [];
  const wire = new ScriptedWire([
    { kind: 'error', error: new ProviderHttpError(503, 'unavailable', { retryAfterMs: 50 }) },
    ev(...answer('recovered and answered')),
  ]);
  const deps = buildDeps(wire, new ToolRegistry(), {
    recoverer: createRecoverer([retryAfterStrategy({ sleep: async (ms) => void slept.push(ms) })]),
  });
  let state = initialState({ sid: 's', model: 'scripted-1', maxIterations: 10 });
  state = reduce(state, { t: 'user_msg', blocks: [{ kind: 'text', text: 'hi' }] });
  const { reason, state: finalState } = await drive(state, deps);
  assert.equal(reason, 'end_turn');
  assert.deepEqual(slept, [50]);
  assert.equal(finalState.history.length, 2); // user + one clean assistant turn
});

test('P7 gate: plain answer with no tools asserts end_turn', async () => {
  const wire = new ScriptedWire([ev(...answer('just a plain reply'))]);
  const deps = buildDeps(wire, new ToolRegistry());
  let state = initialState({ sid: 's', model: 'scripted-1', maxIterations: 10 });
  state = reduce(state, { t: 'user_msg', blocks: [{ kind: 'text', text: 'hello' }] });
  const { reason, events } = await drive(state, deps);
  assert.equal(reason, 'end_turn');
  assert.ok(events.some((e) => e.t === 'text_delta' && e.text === 'just a plain reply'));
});

test('P7 gate: a hard error with no recovery asserts fatal_error', async () => {
  const wire = new ScriptedWire([{ kind: 'error', error: new ProviderHttpError(400, 'bad request', {}) }]);
  const deps = buildDeps(wire, new ToolRegistry(), {
    recoverer: createRecoverer([retryAfterStrategy({ sleep: async () => {} })]),
  });
  let state = initialState({ sid: 's', model: 'scripted-1', maxIterations: 10 });
  state = reduce(state, { t: 'user_msg', blocks: [{ kind: 'text', text: 'hi' }] });
  const { reason } = await drive(state, deps);
  assert.equal(reason, 'fatal_error');
});
