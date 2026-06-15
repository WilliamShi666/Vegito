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
import type { ReplPorts, ReplInputRequest } from '../../../src/ui/repl.ts';
import type { AskSpec, LoopEvent } from '../../../src/kernel/events.ts';
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
    assert.deepEqual(settled, [['ask-1', 'allow']]);
    assert.match(s.text(), /Allow write\?/);
    assert.match(s.text(), /proceeding/);
  });

  test('permission asks accept short aliases and request a permission prompt', async () => {
    const s = sink();
    const settled: Array<[string, string]> = [];
    const requests: ReplInputRequest[] = [];
    const spec: AskSpec = {
      kind: 'permission',
      title: 'Allow ls (read): /tmp?',
      tool: 'ls',
      action: 'read',
      target: '/tmp',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
    };
    async function* askingTurn(): AsyncGenerator<LoopEvent, TurnResult> {
      yield { t: 'turn_start', turn: 0 };
      yield { t: 'ask', askId: 'ask-1', spec };
      yield { t: 'turn_end', reason: 'end_turn', usage: U };
      return endResult;
    }
    const lines = ['list files', 'a'];
    let i = 0;
    const ports: ReplPorts = {
      nextLine: async (request) => {
        if (request !== undefined) requests.push(request);
        return i < lines.length ? lines[i++]! : null;
      },
      write: s.write,
      startTurn: () => askingTurn(),
      settleAsk: (id, ans) => settled.push([id, ans]),
    };

    await runRepl(ports);

    assert.deepEqual(settled, [['ask-1', 'allow']]);
    assert.equal(requests[0]?.kind, 'chat');
    assert.equal(requests[1]?.kind, 'permission');
    assert.equal(requests[1]?.askId, 'ask-1');
  });

  test('malformed permission answers re-prompt instead of becoming user messages', async () => {
    const s = sink();
    const settled: Array<[string, string]> = [];
    let turns = 0;
    const requests: ReplInputRequest[] = [];
    const spec: AskSpec = {
      kind: 'permission',
      title: 'Allow edit?',
      tool: 'edit',
      action: 'write',
      target: '/tmp/a.txt',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
    };
    async function* askingTurn(): AsyncGenerator<LoopEvent, TurnResult> {
      yield { t: 'turn_start', turn: 0 };
      yield { t: 'ask', askId: 'ask-1', spec };
      yield { t: 'turn_end', reason: 'end_turn', usage: U };
      return endResult;
    }
    const lines = ['edit file', 'maybe', 'd'];
    let i = 0;
    const ports: ReplPorts = {
      nextLine: async (request) => {
        if (request !== undefined) requests.push(request);
        return i < lines.length ? lines[i++]! : null;
      },
      write: s.write,
      startTurn: () => {
        turns += 1;
        return askingTurn();
      },
      settleAsk: (id, ans) => settled.push([id, ans]),
    };

    await runRepl(ports);

    assert.equal(turns, 1);
    assert.deepEqual(settled, [['ask-1', 'deny']]);
    assert.equal(requests.filter((request) => request.kind === 'permission').length, 2);
    assert.match(s.text(), /Please answer with/i);
  });

  test('EOF during a permission ask fails closed to deny', async () => {
    const s = sink();
    const settled: Array<[string, string]> = [];
    const spec: AskSpec = {
      kind: 'permission',
      title: 'Allow write?',
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
    };
    async function* askingTurn(): AsyncGenerator<LoopEvent, TurnResult> {
      yield { t: 'turn_start', turn: 0 };
      yield { t: 'ask', askId: 'ask-1', spec };
      yield { t: 'turn_end', reason: 'end_turn', usage: U };
      return endResult;
    }
    const lines: Array<string | null> = ['edit file', null];
    let i = 0;
    const ports: ReplPorts = {
      nextLine: async () => (i < lines.length ? lines[i++]! : null),
      write: s.write,
      startTurn: () => askingTurn(),
      settleAsk: (id, ans) => settled.push([id, ans]),
    };

    await runRepl(ports);

    assert.deepEqual(settled, [['ask-1', 'deny']]);
  });

  test('a local slash command writes directly without starting a model turn', async () => {
    const s = sink();
    let turns = 0;
    const ports: ReplPorts = {
      nextLine: lineQueue(['/packs']),
      write: s.write,
      startTurn: () => {
        turns += 1;
        return answerTurn('x');
      },
      settleAsk: () => {},
      commands: {
        packs: () => ({ kind: 'local', text: 'generated packs: demo' }),
      },
    };

    await runRepl(ports);

    assert.equal(turns, 0);
    assert.match(s.text(), /generated packs: demo/);
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
