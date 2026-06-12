// Fragment registry (DESIGN §6, codex/01). Mutable context — todo state, file
// freshness, agent board — is registered as named fragments. Each turn only
// the fragments that CHANGED since the last delta() re-emit, as late-position
// user-message items. Unchanged fragments stay out of the request body so they
// never perturb the cached prefix and never re-spend tokens.
//
// Removal emits a one-shot tombstone (empty content, removed: true) so the UI
// / message stream can drop a fragment that no longer applies, then forgets it.

export interface Fragment {
  readonly id: string;
  readonly content: string;
  readonly removed?: boolean;
}

export interface FragmentRegistry {
  set(id: string, content: string): void;
  remove(id: string): void;
  /** Fragments changed since the previous delta(), in registration order. */
  delta(): readonly Fragment[];
  /** All live (non-removed) fragments, in registration order. */
  snapshot(): readonly Fragment[];
}

export function createFragmentRegistry(): FragmentRegistry {
  // Insertion-ordered: Map preserves first-set order, which we keep stable
  // across content updates so the emit order never churns.
  const live = new Map<string, string>();
  const order: string[] = [];
  const dirty = new Set<string>();
  const tombstones = new Set<string>();

  const track = (id: string): void => {
    if (!order.includes(id)) order.push(id);
  };

  return {
    set(id: string, content: string): void {
      if (live.get(id) === content && !tombstones.has(id)) return; // no change
      track(id);
      live.set(id, content);
      tombstones.delete(id);
      dirty.add(id);
    },
    remove(id: string): void {
      if (!live.has(id)) return;
      live.delete(id);
      tombstones.add(id);
      dirty.add(id);
    },
    delta(): readonly Fragment[] {
      const out: Fragment[] = [];
      for (const id of order) {
        if (!dirty.has(id)) continue;
        if (tombstones.has(id)) {
          out.push({ id, content: '', removed: true });
          tombstones.delete(id);
        } else {
          out.push({ id, content: live.get(id) ?? '' });
        }
      }
      dirty.clear();
      return out;
    },
    snapshot(): readonly Fragment[] {
      return order.filter((id) => live.has(id)).map((id) => ({ id, content: live.get(id) ?? '' }));
    },
  };
}
