// Command intake with drain modes (DESIGN §3.3): input arriving mid-turn,
// mid-startup, or mid-compaction is never lost — it queues, and the loop
// drains what the current mode allows, FIFO.

export type DrainMode = 'accept' | 'defer_startup' | 'defer_compact';

export type CommandKind = 'user_msg' | 'interrupt' | 'control';

export interface QueuedCommand {
  id: string;
  kind: CommandKind;
  payload?: unknown;
}

const ELIGIBLE: Record<DrainMode, readonly CommandKind[]> = {
  accept: ['user_msg', 'interrupt', 'control'],
  defer_startup: ['interrupt', 'control'],
  defer_compact: ['interrupt'],
};

export class CommandQueue {
  #items: QueuedCommand[] = [];

  get size(): number {
    return this.#items.length;
  }

  push(cmd: QueuedCommand): void {
    this.#items = [...this.#items, cmd];
  }

  drain(mode: DrainMode): QueuedCommand[] {
    const eligible = ELIGIBLE[mode];
    const taken = this.#items.filter((c) => eligible.includes(c.kind));
    this.#items = this.#items.filter((c) => !eligible.includes(c.kind));
    return taken;
  }
}
