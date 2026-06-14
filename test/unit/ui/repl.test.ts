// P10 REPL core (DESIGN §11): the interactive loop as a pure driver over four
// injected ports — nextLine (stdin or a scripted queue), write, startTurn (a
// factory that reduces the user's text into the session and returns a runTurn
// generator), and settleAsk (resolves a permission ask by id). Keeping these as
// ports means the whole REPL drives offline in tests with no TTY. Slash
// commands are handled before a turn ever starts; an `ask` event mid-turn pulls
// the next input line as the answer and settles the broker, exactly matching
// the executor's surface-then-await ask protocol.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { runRepl } from '../../../src/ui/repl.ts';
import type { ReplPorts } from '../../../src/ui/repl.ts';
import type { LoopEvent } from '../../../src/kernel/events.ts';
import type { TurnResult } from '../../../src/kernel/loop.ts';
import { initialState } from '../../../src/kernel/state.ts';
import type { Usage } from '../../../src/providers/types.ts';

const U: Usage = { in: 2, out: 1, cacheRead: 0, cacheWrite: 0 };
const endState = initialState({ sid: 's', model: 'm' });
const endResult: TurnResult = { state: endState, reason: 'end_turn' };

// A scripted line source that hands out queued lines then EOF (null).
function lineQueue(lines: string[]): () => Promise<string | null> {
  let i = 0;
  return async () => (i < lines.length ? lines[i++]! : null);
}

async function* answerTurn(text: string): AsyncGenerator<LoopEvent, TurnResult> {
  yield { t: 'turn_start', turn: 0 };
  yield { t: 'text_delta', text: `echo: ${text}` };
  yield { t: 'turn_end', reason: 'end_turn', usage: U };
  return endResult;
}

function sink() {
  const out: string[] = [];
  return { write: (s: string) => out.push(s), text: () => out.join('') };
}

describe('runRepl', () => {
  test('runs a turn per input line and renders the assistant text', async () => {
    const s = sink();
    const ports: ReplPorts = {
      nextLine: lineQueue(['hello', 'world']),
      write: s.write,
      startTurn: (text) => answerTurn(text),
      settleAsk: () => {},
    };
    await runRepl(ports);
    assert.match(s.text(), /echo: hello/);
    assert.match(s.text(), /echo: world/);
  });

  test('a slash command renders its template and starts a model turn', async () => {
    const s = sink();
    const seen: string[] = [];
    let turns = 0;
    const ports: ReplPorts = {
      nextLine: lineQueue(['/toefl-diagnose my sample answer', 'real prompt']),
      write: s.write,
      startTurn: (text) => {
        turns += 1;
        seen.push(text);
        return answerTurn(text);
      },
      settleAsk: () => {},
      commands: { 'toefl-diagnose': (args) => `Run TOEFL diagnosis on: ${args}` },
    };
    await runRepl(ports);
    assert.equal(turns, 2, 'the slash command and normal prompt both start turns');
    assert.equal(seen[0], 'Run TOEFL diagnosis on: my sample answer');
    assert.match(s.text(), /echo: Run TOEFL diagnosis on: my sample answer/);
    assert.match(s.text(), /echo: real prompt/);
  });

  test('an unknown slash command reports itself and starts no turn', async () => {
    const s = sink();
    let turns = 0;
    const ports: ReplPorts = {
      nextLine: lineQueue(['/nope']),
      write: s.write,
      startTurn: () => {
        turns += 1;
        return answerTurn('x');
      },
      settleAsk: () => {},
      commands: {},
    };
    await runRepl(ports);
    assert.equal(turns, 0);
    assert.match(s.text(), /unknown|nope/i);
  });

  test('an ask mid-turn pulls the next line as the answer and settles the broker', async () => {
    const s = sink();
    const settled: Array<[string, string]> = [];
    async function* askingTurn(): AsyncGenerator<LoopEvent, TurnResult> {
      yield { t: 'turn_start', turn: 0 };
      yield { t: 'ask', askId: 'ask-1', spec: { kind: 'permission', title: 'Allow write?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] } };
      yield { t: 'text_delta', text: 'proceeding' };
      yield { t: 'turn_end', reason: 'end_turn', usage: U };
      return endResult;
    }
    const ports: ReplPorts = {
      nextLine: lineQueue(['do the thing', 'y']),
      write: s.write,
      startTurn: () => askingTurn(),
      settleAsk: (id, ans) => settled.push([id, ans]),
    };
    await runRepl(ports);
    assert.deepEqual(settled, [['ask-1', 'y']]);
    assert.match(s.text(), /Allow write\?/);
    assert.match(s.text(), /proceeding/);
  });

  test('EOF (null line) ends the REPL cleanly', async () => {
    const s = sink();
    const ports: ReplPorts = {
      nextLine: async () => null,
      write: s.write,
      startTurn: () => answerTurn('never'),
      settleAsk: () => {},
    };
    await runRepl(ports); // resolves, does not hang
    assert.doesNotMatch(s.text(), /echo:/);
  });
});
