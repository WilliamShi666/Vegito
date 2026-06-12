// The fixture provider (DESIGN §12): plays back a script of responses,
// errors, and stalls. Every integration test in the repo drives the real
// loop through this wire — no network, no mocks of our own code.

import type { NeutralRequest, ProviderEvent, Usage, WireProtocol } from '../types.ts';
import type { ProviderHttpError } from '../errors.ts';

export type ScriptedStep =
  | { kind: 'events'; events: readonly ProviderEvent[] }
  | { kind: 'error'; error: ProviderHttpError }
  | { kind: 'stall'; afterEvents: readonly ProviderEvent[] };

export function scriptedText(text: string, opts?: { usage?: Usage; model?: string }): ProviderEvent[] {
  return [
    { t: 'msg_start', model: opts?.model ?? 'scripted-1' },
    { t: 'text_delta', text },
    { t: 'msg_end', stop: 'end_turn', usage: opts?.usage ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
  ];
}

export class ScriptedWire implements WireProtocol {
  readonly name = 'scripted';
  readonly calls: NeutralRequest[] = [];
  #script: readonly ScriptedStep[];
  #cursor = 0;

  constructor(script: readonly ScriptedStep[]) {
    this.#script = script;
  }

  send(req: NeutralRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    this.calls.push(req);
    const step = this.#script[this.#cursor++];
    return this.#play(step, signal);
  }

  async *#play(step: ScriptedStep | undefined, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (step === undefined) throw new Error('ScriptedWire: script exhausted');
    if (step.kind === 'error') throw step.error;
    const events = step.kind === 'events' ? step.events : step.afterEvents;
    for (const ev of events) {
      if (signal.aborted) throw signal.reason;
      yield ev;
    }
    if (step.kind === 'stall') {
      await new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
  }
}
