// P10 REPL core (DESIGN §11): the interactive loop as a pure driver over four
// injected ports, so it tests offline with no TTY. nextLine yields user input
// (or null at EOF); write is the output sink; startTurn reduces a line into the
// session and returns a runTurn generator; settleAsk resolves a permission ask
// by id. Slash commands are dispatched before any turn starts. An `ask` event
// mid-turn pulls the next input line as the answer and settles the broker —
// matching the executor's surface-then-await protocol — then the turn resumes.

import type { AskSpec, LoopEvent } from '../kernel/events.ts';
import type { TurnResult } from '../kernel/loop.ts';
import { renderEvent } from './render.ts';

export type ReplInputRequest =
  | { readonly kind: 'chat' }
  | { readonly kind: 'permission'; readonly askId: string; readonly spec: AskSpec; readonly invalid?: boolean };

export type CommandResult = string | { readonly kind: 'turn'; readonly text: string } | { readonly kind: 'local'; readonly text: string };
export type CommandHandler = (args: string) => CommandResult;

export interface ReplPorts {
  /** Next line of user input, or null at end of stream. */
  nextLine: (request?: ReplInputRequest) => Promise<string | null>;
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

function normalizePermissionAnswer(raw: string): 'allow' | 'deny' | 'details' | undefined {
  const value = raw.trim().toLowerCase();
  if (value === 'a' || value === 'allow' || value === 'y' || value === 'yes') return 'allow';
  if (value === 'd' || value === 'deny' || value === 'n' || value === 'no') return 'deny';
  if (value === '?' || value === 'details' || value === 'detail') return 'details';
  return undefined;
}

async function readAskAnswer(ports: ReplPorts, askId: string, spec: AskSpec): Promise<string> {
  if (spec.kind !== 'permission') {
    return (await ports.nextLine({ kind: 'permission', askId, spec })) ?? '';
  }

  let invalid = false;
  for (;;) {
    const answer = await ports.nextLine({ kind: 'permission', askId, spec, ...(invalid ? { invalid: true } : {}) });
    if (answer === null) return 'deny';
    const normalized = normalizePermissionAnswer(answer ?? '');
    if (normalized === 'allow' || normalized === 'deny') return normalized;
    if (normalized === 'details') {
      const frame = renderEvent({ t: 'ask', askId, spec });
      if (frame !== null) ports.write(`${frame.text}\n`);
    } else {
      ports.write('Please answer with [a] allow, [d] deny, or [?] details.\n');
    }
    invalid = true;
  }
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
      const answer = await readAskAnswer(ports, ev.askId, ev.spec);
      ports.settleAsk(ev.askId, answer);
    }
    step = await gen.next();
  }
}

export async function runRepl(ports: ReplPorts): Promise<void> {
  const commands = ports.commands ?? {};
  for (;;) {
    const line = await ports.nextLine({ kind: 'chat' });
    if (line === null) return; // EOF
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const slash = parseSlash(trimmed);
    if (slash) {
      const handler = commands[slash.name];
      if (handler) {
        const result = handler(slash.args);
        const commandResult = typeof result === 'string' ? { kind: 'turn' as const, text: result } : result;
        if (commandResult.kind === 'local') {
          ports.write(commandResult.text.endsWith('\n') ? commandResult.text : `${commandResult.text}\n`);
        } else {
          await runOneTurn(ports, commandResult.text);
        }
      } else {
        ports.write(`unknown command: /${slash.name}\n`);
      }
      continue;
    }

    await runOneTurn(ports, trimmed);
  }
}
