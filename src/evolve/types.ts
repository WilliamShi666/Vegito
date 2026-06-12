// Evolution type algebra (DESIGN §8). A forked-child review of a session
// transcript yields typed Observations; observations accumulate into Proposals
// (diffs against pack files, or memory promotions); proposals are applied
// through the same permission gate as everything else, as versioned mutations
// with provenance and a byte-identical revert. Nothing here does IO — these are
// the plain serializable shapes the three stages exchange.

// Memory promotion ladder: L1 episodic (raw per-session facts) → L2 curated
// (facts that recurred / proved durable) → L3 synthesis (distilled guidance).
export const MEMORY_LEVELS = Object.freeze(['l1', 'l2', 'l3'] as const);
export type MemoryLevel = (typeof MEMORY_LEVELS)[number];

export function nextLevel(level: MemoryLevel): MemoryLevel | undefined {
  const i = MEMORY_LEVELS.indexOf(level);
  return i >= 0 && i < MEMORY_LEVELS.length - 1 ? MEMORY_LEVELS[i + 1] : undefined;
}

export const OBSERVATION_KINDS = Object.freeze([
  'friction',
  'rubric_drift',
  'missing_skill',
  'memory_candidate',
] as const);
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

// What the reviewer (a model, or a scripted fixture in tests) emits — kind plus
// the fields each kind needs to become a proposal. The engine stamps id + sid;
// the reviewer never invents those.
export type RawObservation =
  | { readonly kind: 'friction'; readonly summary: string; readonly constraint: string }
  | { readonly kind: 'rubric_drift'; readonly summary: string; readonly rubric: string; readonly guidance: string }
  | { readonly kind: 'missing_skill'; readonly summary: string; readonly skill: string }
  | {
      readonly kind: 'memory_candidate';
      readonly summary: string;
      readonly fact: string;
      readonly level: MemoryLevel;
    };

interface ObservationId {
  readonly id: string;
  readonly sid: string;
}

export type Observation = RawObservation & ObservationId;

export function isMemoryLevel(v: string): v is MemoryLevel {
  return (MEMORY_LEVELS as readonly string[]).includes(v);
}

export function isObservationKind(v: string): v is ObservationKind {
  return (OBSERVATION_KINDS as readonly string[]).includes(v);
}

// A proposal is a concrete, reviewable mutation. Two shapes:
//   pack_edit       — append `text` to a declared pack file (persona, onboarding,
//                     or a rubric prompt). Append-only: evolution never rewrites
//                     existing guidance, it adds to it (auditable, revertible).
//   memory_promote  — move a fact up the ladder: write it into the `to` level
//                     file under the pack's memory dir, with provenance.
export type Proposal =
  | {
      readonly kind: 'pack_edit';
      readonly id: string;
      readonly target: string; // pack-relative path, e.g. "persona.md"
      readonly text: string; // appended verbatim (with a leading blank line)
      readonly provenance: readonly string[]; // observation ids
    }
  | {
      readonly kind: 'memory_promote';
      readonly id: string;
      readonly fact: string;
      readonly from: MemoryLevel;
      readonly to: MemoryLevel;
      readonly provenance: readonly string[];
    };

// One applied batch. Recorded to .evolve/provenance.jsonl so a later revert can
// restore the exact prior bytes (snapshots) and drop the version bump.
export interface ProvenanceRecord {
  readonly schema: 1;
  readonly version: string; // the pack version AFTER this batch
  readonly prevVersion: string; // the pack version BEFORE this batch
  readonly proposals: readonly string[]; // proposal ids applied
  readonly observations: readonly string[]; // contributing observation ids
  readonly sids: readonly string[]; // sessions the observations came from
  // pack-relative path → prior content, or null if the file did not exist.
  readonly snapshot: Readonly<Record<string, string | null>>;
}
