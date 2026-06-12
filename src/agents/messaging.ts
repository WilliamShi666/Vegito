// P9 messaging (DESIGN §9): a per-recipient mailbox with two delivery modes.
// QueueOnly enqueues for the recipient's next natural turn; TriggerTurn
// enqueues and additionally wakes the recipient via its registered waker (if
// any). drain() returns and clears a recipient's queue — called at the start
// of a turn so messages survive until the agent actually runs. This is the
// whole coordination contract; the kernel decides what "a turn" means.

export type DeliveryMode = 'QueueOnly' | 'TriggerTurn';

export interface AgentMessage {
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly mode: DeliveryMode;
}

export interface Mailbox {
  send(msg: AgentMessage): void;
  drain(recipient: string): readonly AgentMessage[];
  pending(recipient: string): boolean;
  registerWaker(recipient: string, wake: () => void): void;
}

export function createMailbox(): Mailbox {
  const queues = new Map<string, AgentMessage[]>();
  const wakers = new Map<string, () => void>();

  const queueFor = (recipient: string): AgentMessage[] => {
    let q = queues.get(recipient);
    if (!q) {
      q = [];
      queues.set(recipient, q);
    }
    return q;
  };

  return {
    send: (msg) => {
      queueFor(msg.to).push(msg);
      if (msg.mode === 'TriggerTurn') wakers.get(msg.to)?.();
    },
    drain: (recipient) => {
      const q = queues.get(recipient);
      if (!q || q.length === 0) return [];
      const out = q.slice();
      q.length = 0;
      return out;
    },
    pending: (recipient) => (queues.get(recipient)?.length ?? 0) > 0,
    registerWaker: (recipient, wake) => {
      wakers.set(recipient, wake);
    },
  };
}
