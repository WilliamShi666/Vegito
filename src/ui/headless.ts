// P10 headless runner (DESIGN §11): drains a runTurn event stream to a write
// sink and maps the terminal ExitReason to a process exit code. `--json` emits
// one JSON object per LoopEvent (the same algebra the REPL and trace consume);
// text mode prints rendered frames. It takes the generator, not the deps, so it
// drives offline in tests with no network and no real process.

import type { LoopEvent, ExitReason } from '../kernel/events.ts';
import type { TurnResult } from '../kernel/loop.ts';
import { renderEvent } from './render.ts';

// Each ExitReason has a stable, distinct exit code. Clean stops are 0;
// interrupted follows the 128+SIGINT(2) convention; error-class reasons get
// their own non-zero codes so a caller can branch on why a run stopped.
const EXIT_CODES: Record<ExitReason, number> = {
  end_turn: 0,
  awaiting_input: 0,
  interrupted: 130,
  fatal_error: 1,
  max_iterations: 2,
  budget_tokens: 3,
  denial_breaker: 4,
};

export function exitCodeForReason(reason: ExitReason): number {
  return EXIT_CODES[reason];
}

export interface HeadlessOptions {
  readonly write: (s: string) => void;
  readonly json: boolean;
}

export interface HeadlessResult {
  readonly reason: ExitReason;
  readonly code: number;
  readonly state: TurnResult['state'];
}

// In text mode, the assistant's streamed text is the payload — print it raw so
// it concatenates into prose. Every other channel is a discrete line.
function writeFrameText(write: (s: string) => void, ev: LoopEvent): void {
  const frame = renderEvent(ev);
  if (!frame) return;
  if (frame.channel === 'text') write(frame.text);
  else write(`${frame.text}\n`);
}

export async function runHeadless(
  gen: AsyncGenerator<LoopEvent, TurnResult>,
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  let step = await gen.next();
  while (!step.done) {
    const ev = step.value;
    if (opts.json) opts.write(`${JSON.stringify(ev)}\n`);
    else writeFrameText(opts.write, ev);
    step = await gen.next();
  }
  const result = step.value;
  if (!opts.json) opts.write('\n');
  return { reason: result.reason, code: exitCodeForReason(result.reason), state: result.state };
}
