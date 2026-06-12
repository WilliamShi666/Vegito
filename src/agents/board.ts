// P9 board (DESIGN §9). An in-process coordination board for detached
// children. JavaScript's single-threaded execution makes claim() atomic by
// construction: the check ("is this task open?") and the set ("mark it mine")
// run with no await between them, so no two claimers can both observe an open
// task. Heartbeats + a staleness window let a live worker hold a claim while
// letting a dead worker's claim be taken over. complete() writes the result in
// the same synchronous step that flips status to 'done' — done-after-writes,
// so a reader that sees 'done' always sees the result.

export type TaskStatus = 'open' | 'claimed' | 'done';

export interface Task {
  readonly id: string;
  readonly status: TaskStatus;
  readonly owner?: string;
  readonly lastHeartbeat?: number;
  readonly result?: string;
}

export interface BoardOpts {
  /** Injectable clock for deterministic heartbeat tests. */
  now?: () => number;
  /** Claims whose heartbeat is older than this may be reclaimed. */
  staleMs?: number;
}

export interface Board {
  add(id: string): void;
  claim(id: string, owner: string): boolean;
  heartbeat(id: string, owner: string): void;
  complete(id: string, owner: string, result: string): void;
  get(id: string): Task | undefined;
  list(): readonly Task[];
  openTasks(): readonly Task[];
}

export function createBoard(opts: BoardOpts = {}): Board {
  const now = opts.now ?? (() => Date.now());
  const staleMs = opts.staleMs ?? 60_000;
  const tasks = new Map<string, Task>();

  const isReclaimable = (t: Task): boolean =>
    t.status === 'claimed' && t.lastHeartbeat !== undefined && now() - t.lastHeartbeat >= staleMs;

  return {
    add: (id) => {
      if (!tasks.has(id)) tasks.set(id, { id, status: 'open' });
    },
    // Atomic check-and-set: no await between reading status and writing it.
    claim: (id, owner) => {
      const t = tasks.get(id);
      if (!t) return false;
      if (t.status === 'open' || isReclaimable(t)) {
        tasks.set(id, { id, status: 'claimed', owner, lastHeartbeat: now() });
        return true;
      }
      return false;
    },
    heartbeat: (id, owner) => {
      const t = tasks.get(id);
      if (!t || t.owner !== owner || t.status !== 'claimed') return;
      tasks.set(id, { ...t, lastHeartbeat: now() });
    },
    complete: (id, owner, result) => {
      const t = tasks.get(id);
      if (!t) throw new Error(`unknown task ${id}`);
      if (t.owner !== owner) throw new Error(`task ${id} owner is ${t.owner ?? '(none)'}, not ${owner}`);
      tasks.set(id, { id, status: 'done', owner, result });
    },
    get: (id) => tasks.get(id),
    list: () => [...tasks.values()],
    openTasks: () => [...tasks.values()].filter((t) => t.status === 'open' || isReclaimable(t)),
  };
}
