// P10 REPL core (DESIGN §11): the interactive loop as a pure driver over four
// injected ports, so it tests offline with no TTY. nextLine yields user input
// (or null at EOF); write is the output sink; startTurn reduces a line into the
// session and returns a runTurn generator; settleAsk resolves a permission ask
// by id. Slash commands are dispatched before any turn starts. An `ask` event
// mid-turn pulls the next input line as the answer and settles the broker —
// matching the executor's surface-then-await protocol — then the turn resumes.

import type { LoopEvent } from '../kernel/events.ts';
import type { TurnResult } from '../kernel/loop.ts';
import { renderEvent } from './render.ts';

export type CommandHandler = (args: string) => string;

export interface ReplPorts {
  /** Next line of user input, or null at end of stream. */
  nextLine: () => Promise<string | null>;
  /** Output sink. */
  write: (s: string) => void;
  /** Reduce a user line into the session and start a turn. */
  startTurn: (text: string) => AsyncGenerator<LoopEvent, TurnResult>;
  /** Resolve a permission ask by id with the user's answer. */
  settleAsk: (askId: string, answer: string) => void;
  /** Slash commands by name (without the leading '/'). */
  commands?: Readonly<Record<string, CommandHandler>>;
}

function writeFrame(write: (s: string) => void, ev: LoopEvent): void {
  const frame = renderEvent(ev);
  if (!frame) return;
  if (frame.channel === 'text') write(frame.text);
  else write(`${frame.text}\n`);
}

// "/name rest" → ['name', 'rest']; a bare "/name" → ['name', ''].
function parseSlash(line: string): { name: string; args: string } | null {
  if (!line.startsWith('/')) return null;
  const body = line.slice(1);
  const sp = body.indexOf(' ');
  return sp === -1 ? { name: body, args: '' } : { name: body.slice(0, sp), args: body.slice(sp + 1) };
}

async function runOneTurn(ports: ReplPorts, text: string): Promise<void> {
  const gen = ports.startTurn(text);
  let step = await gen.next();
  while (!step.done) {
    const ev = step.value;
    writeFrame(ports.write, ev);
    if (ev.t === 'ask') {
      // The executor has surfaced an ask and is awaiting the answer. Pull the
      // next input line, settle the broker, then advance — the generator
      // resumes once decide() sees the resolved deferred.
      const answer = await ports.nextLine();
      ports.settleAsk(ev.askId, answer ?? '');
    }
    step = await gen.next();
  }
}

export async function runRepl(ports: ReplPorts): Promise<void> {
  const commands = ports.commands ?? {};
  for (;;) {
    const line = await ports.nextLine();
    if (line === null) return; // EOF
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const slash = parseSlash(trimmed);
    if (slash) {
      const handler = commands[slash.name];
      if (handler) ports.write(`${handler(slash.args)}\n`);
      else ports.write(`unknown command: /${slash.name}\n`);
      continue;
    }

    await runOneTurn(ports, trimmed);
  }
}
