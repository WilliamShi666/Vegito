// The single tool registry (DESIGN §7.1, §8): builtins, pack tools, and MCP
// tools all live here under one namespace. listHash() is the surface identity
// the cache latch watches (D4) — if the model-visible tool list changes, the
// hash changes, and only then.

import { canonicalHash } from '../lib/hash.ts';
import type { Exposure, ToolSpec } from './spec.ts';

export class ToolRegistry {
  #tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): void {
    if (this.#tools.has(spec.name)) {
      throw new Error(`tool "${spec.name}" already registered`);
    }
    this.#tools.set(spec.name, spec);
  }

  get(name: string): ToolSpec | undefined {
    return this.#tools.get(name);
  }

  /** Model-visible tools: direct + deferred, never hidden. Sorted by name. */
  list(): readonly ToolSpec[] {
    return this.#sorted().filter((t) => t.exposure !== 'hidden');
  }

  listAll(): readonly ToolSpec[] {
    return this.#sorted();
  }

  /** Identity of the exposed tool surface: name + description + schema + exposure. */
  listHash(): string {
    return canonicalHash(
      this.#sorted().map((t) => ({
        name: t.name,
        description: t.description,
        schema: t.schema,
        exposure: t.exposure as Exposure,
      })),
    );
  }

  #sorted(): ToolSpec[] {
    return [...this.#tools.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
}
