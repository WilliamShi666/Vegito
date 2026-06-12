// Agents layer barrel (DESIGN §9): one primitive for multi-agent work — the
// child session. spawn.ts is the depth/concurrency-capped spawn contract with
// byte-stable child cache params; board.ts is the atomic claim/heartbeat/done
// coordination store for detached work; messaging.ts is the QueueOnly vs
// TriggerTurn mailbox. No second orchestration system, no OS process pools (A2).

export { cacheSafeParams, createSpawner, taskNotification } from './spawn.ts';
export type {
  CacheSafeParams,
  ChildResult,
  ChildStatus,
  Spawner,
  SpawnerDeps,
  SpawnSpec,
} from './spawn.ts';

export { createBoard } from './board.ts';
export type { Board, BoardOpts, Task, TaskStatus } from './board.ts';

export { createMailbox } from './messaging.ts';
export type { AgentMessage, DeliveryMode, Mailbox } from './messaging.ts';
