// The tool partition gate (DESIGN §7.1, L4): concurrency-safe calls (reads)
// run in parallel; everything else (writes) runs exclusively. Fair FIFO —
// a queued write is never starved by later-arriving reads.

import { deferred, type Deferred } from '../lib/async.ts';

export type GateMode = 'read' | 'write';

interface Waiter {
  readonly mode: GateMode;
  readonly gate: Deferred<void>;
}

export class RwGate {
  #activeReads = 0;
  #writeActive = false;
  #queue: Waiter[] = [];

  async run<T>(mode: GateMode, task: () => Promise<T> | T): Promise<T> {
    await this.#acquire(mode);
    try {
      return await task();
    } finally {
      this.#release(mode);
    }
  }

  #acquire(mode: GateMode): Promise<void> {
    const idle = !this.#writeActive && (mode === 'read' ? this.#queue.length === 0 : this.#activeReads === 0 && this.#queue.length === 0);
    if (idle) {
      this.#grant(mode);
      return Promise.resolve();
    }
    const gate = deferred<void>();
    this.#queue.push({ mode, gate });
    return gate.promise;
  }

  #grant(mode: GateMode): void {
    if (mode === 'read') this.#activeReads += 1;
    else this.#writeActive = true;
  }

  #release(mode: GateMode): void {
    if (mode === 'read') this.#activeReads -= 1;
    else this.#writeActive = false;
    this.#drain();
  }

  #drain(): void {
    while (this.#queue.length > 0 && !this.#writeActive) {
      const head = this.#queue[0] as Waiter;
      if (head.mode === 'write') {
        if (this.#activeReads > 0) return; // write waits for readers to drain
        this.#queue.shift();
        this.#grant('write');
        head.gate.resolve();
        return; // a write holds exclusively; nothing else starts
      }
      this.#queue.shift();
      this.#grant('read');
      head.gate.resolve();
      // keep granting contiguous reads — they may all run together
    }
  }
}
