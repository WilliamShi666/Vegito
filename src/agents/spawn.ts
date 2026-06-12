// P9 spawn (DESIGN §9): one primitive — the child session. createSpawner is a
// thin coordinator around an injected runChild: it enforces the depth cap
// (a child at depth>=maxDepth may not spawn), bounds sibling concurrency with
// a semaphore, builds the per-child CacheSafeParams once, and converts a child
// throw into a structured error result so a failed delegate never crashes the
// orchestrator's turn. The actual child loop (transcript, narrowed grants,
// ask-bubbling) is provided by the caller as runChild, which keeps this module
// free of the whole kernel and trivially testable.

import { ModelFacingError } from '../kernel/errors.ts';

export interface CacheSafeParams {
  readonly model: string;
  readonly systemHash: string;
  readonly toolListHash: string;
}

/** Frozen so a child's cache-key inputs cannot drift mid-flight (cc/06). */
export function cacheSafeParams(p: CacheSafeParams): CacheSafeParams {
  return Object.freeze({ model: p.model, systemHash: p.systemHash, toolListHash: p.toolListHash });
}

export type ChildStatus = 'ok' | 'error';

export interface SpawnSpec {
  readonly name: string;
  readonly prompt: string;
  /** Depth of the child being spawned (orchestrator is 0). */
  readonly depth: number;
  readonly grants: readonly string[];
  readonly model?: string;
}

export interface ChildResult {
  readonly name: string;
  readonly status: ChildStatus;
  readonly content: string;
}

export interface SpawnerDeps {
  readonly maxDepth: number;
  readonly maxConcurrency: number;
  runChild(spec: SpawnSpec, params: CacheSafeParams): Promise<ChildResult>;
  /** Optional override; default derives a minimal params struct from the spec. */
  cacheParamsFor?(spec: SpawnSpec): CacheSafeParams;
}

export interface Spawner {
  spawn(spec: SpawnSpec): Promise<ChildResult>;
}

export function taskNotification(result: ChildResult): string {
  return `<task-notification name="${result.name}" status="${result.status}">\n${result.content}\n</task-notification>`;
}

// A minimal counting semaphore: acquire waits for a slot, release frees one.
function semaphore(max: number): { run<T>(fn: () => Promise<T>): Promise<T> } {
  let available = max;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (available > 0) {
      available -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next) next();
    else available += 1;
  };
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

export function createSpawner(deps: SpawnerDeps): Spawner {
  const sem = semaphore(deps.maxConcurrency);
  const paramsFor =
    deps.cacheParamsFor ??
    ((spec: SpawnSpec): CacheSafeParams =>
      cacheSafeParams({ model: spec.model ?? 'default', systemHash: 'system', toolListHash: 'tools' }));

  return {
    spawn: (spec) => {
      if (spec.depth >= deps.maxDepth) {
        return Promise.reject(
          new ModelFacingError(
            `cannot spawn "${spec.name}": depth ${spec.depth} reaches the cap ${deps.maxDepth} (subagents may not spawn further subagents)`,
          ),
        );
      }
      const params = paramsFor(spec);
      return sem.run(async () => {
        try {
          return await deps.runChild(spec, params);
        } catch (err) {
          return { name: spec.name, status: 'error', content: err instanceof Error ? err.message : String(err) };
        }
      });
    },
  };
}
