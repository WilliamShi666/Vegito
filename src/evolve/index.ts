// Public surface of the evolution engine (DESIGN §8). Three stages: observe
// (transcript → typed Observations via an injected reviewer), propose
// (Observations → Proposals, pure), apply (Proposals → gated, versioned,
// revertible pack mutations). The CLI wires the reviewer to a forked-child
// model call and the gate to the same permission engine everything else uses.

export {
  MEMORY_LEVELS,
  OBSERVATION_KINDS,
  nextLevel,
  isMemoryLevel,
  isObservationKind,
} from './types.ts';
export type {
  MemoryLevel,
  ObservationKind,
  RawObservation,
  Observation,
  Proposal,
  ProvenanceRecord,
} from './types.ts';

export { observe } from './observe.ts';
export type { Reviewer } from './observe.ts';

export { buildReviewer } from './review.ts';

export { propose } from './propose.ts';
export type { ProposeOpts } from './propose.ts';

export { applyProposals, revert, bumpVersion } from './apply.ts';
export type { Gate, GateVerdict, ApplyOpts, ApplyResult } from './apply.ts';
