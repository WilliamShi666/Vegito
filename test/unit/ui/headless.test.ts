// P10 headless runner (DESIGN §11): drains a runTurn event stream to a write
// sink — one JSON object per line in `--json` mode, rendered frames otherwise —
// and maps the terminal ExitReason to a process exit code. It takes the
// generator, not the deps, so the whole thing tests offline without a network
// or a real process. The same LoopEvents drive the REPL and the trace log (D11).

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { runHeadless, exitCodeForReason } from '../../../src/ui/headless.ts';
import type { LoopEvent, ExitReason } from '../../../src/kernel/events.ts';
import type { TurnResult } from '../../../src/kernel/loop.ts';
import { initialState } from '../../../src/kernel/state.ts';
import type { Usage } from '../../../src/providers/types.ts';

const U: Usage = { in: 3, out: 1, cacheRead: 0, cacheWrite: 0 };

// A canned generator standing in for runTurn(state, deps).
async function* scriptedTurn(events: LoopEvent[], result: TurnResult): AsyncGenerator<LoopEvent, TurnResult> {
  for (const e of events) yield e;
  return result;
}

function sink() {
  const out: string[] = [];
  return { write: (s: string) => out.push(s), text: () => out.join(''), lines: () => out.join('').split('\n').filter(Boolean) };
}

const endState = initialState({ sid: 's', model: 'm' });

describe('exitCodeForReason', () => {
  test('end_turn and awaiting_input are clean exits', () => {
    assert.equal(exitCodeForReason('end_turn'), 0);
    assert.equal(exitCodeForReason('awaiting_input'), 0);
  });
  test('interrupted maps to 130 (SIGINT convention)', () => {
    assert.equal(exitCodeForReason('interrupted'), 130);
  });
  test('error-class reasons are non-zero and distinct', () => {
    const codes = (['max_iterations', 'budget_tokens', 'denial_breaker', 'fatal_error'] as ExitReason[]).map(exitCodeForReason);
    assert.ok(codes.every((c) => c !== 0));
    assert.equal(new Set(codes).size, codes.length, 'each error reason has a distinct code');
  });
});

describe('runHeadless', () => {
  test('--json streams one JSON object per LoopEvent', async () => {
    const events: LoopEvent[] = [
      { t: 'turn_start', turn: 0 },
      { t: 'text_delta', text: 'hello' },
      { t: 'turn_end', reason: 'end_turn', usage: U },
    ];
    const s = sink();
    const res = await runHeadless(scriptedTurn(events, { state: endState, reason: 'end_turn' }), { write: s.write, json: true });

    assert.equal(res.code, 0);
    assert.equal(res.reason, 'end_turn');
    const parsed = s.lines().map((l) => JSON.parse(l));
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed[0], { t: 'turn_start', turn: 0 });
    assert.equal(parsed[1].text, 'hello');
    assert.equal(parsed[2].reason, 'end_turn');
  });

  test('text mode renders frames; assistant text appears, turn_start does not', async () => {
    const events: LoopEvent[] = [
      { t: 'turn_start', turn: 0 },
      { t: 'text_delta', text: 'the answer is 42' },
      { t: 'tool_start', callId: 'c1', name: 'read', input: { path: 'a.ts' } },
      { t: 'tool_end', callId: 'c1', ok: true },
      { t: 'turn_end', reason: 'end_turn', usage: U },
    ];
    const s = sink();
    const res = await runHeadless(scriptedTurn(events, { state: endState, reason: 'end_turn' }), { write: s.write, json: false });

    assert.equal(res.code, 0);
    const text = s.text();
    assert.match(text, /the answer is 42/);
    assert.match(text, /read/);
    assert.doesNotMatch(text, /turn_start/);
  });

  test('a fatal_error turn returns a non-zero code', async () => {
    const events: LoopEvent[] = [
      { t: 'turn_start', turn: 0 },
      { t: 'notice', level: 'warn', text: 'kaboom' },
      { t: 'turn_end', reason: 'fatal_error', usage: U },
    ];
    const s = sink();
    const res = await runHeadless(scriptedTurn(events, { state: endState, reason: 'fatal_error' }), { write: s.write, json: false });
    assert.notEqual(res.code, 0);
    assert.equal(res.reason, 'fatal_error');
  });
});
