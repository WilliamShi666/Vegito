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
  validateRawObservation,
} from './types.ts';
export type {
  MemoryLevel,
  ObservationKind,
  RawObservation,
  Observation,
  Proposal,
  ProvenanceRecord,
  ArtifactKind,
  EvolutionMetric,
  EvolutionDecision,
  ActivationEvidence,
  EvolutionRun,
  ProposerKind,
  FailureLayer,
  AtomicEditOperation,
  EvalSuite,
  CandidateProposer,
  CandidateDiagnosis,
  AtomicEdit,
  ParetoMetadata,
  CandidateBundle,
  EvidenceContract,
  EvalMetricSnapshot,
  EditAblationResult,
  EvalCase,
  EvalReportMetrics,
  EvalPromotionDecision,
  CandidateEvalReport,
  RejectedEditRecord,
} from './types.ts';

export { observe } from './observe.ts';
export type { Reviewer } from './observe.ts';

export { buildReviewer } from './review.ts';

export { propose } from './propose.ts';
export type { ProposeOpts } from './propose.ts';

export { applyProposals, revert, bumpVersion } from './apply.ts';
export type { Gate, GateVerdict, ApplyOpts, ApplyResult } from './apply.ts';

export { artifactForProposal, validateProposalTarget } from './artifacts.ts';
export type { ArtifactAdapter, ProposalTargetValidation } from './artifacts.ts';

export { buildEvolutionRun, appendEvolutionRun, EVOLUTION_RUNS } from './evaluation.ts';

export {
  candidateToProposal,
  defaultEvidenceContract,
  editFingerprint,
  validateCandidateBundle,
} from './candidate.ts';
export type { CandidateValidation } from './candidate.ts';

export { importGepaCandidate } from './gepa.ts';

export { evaluateCandidateBundle } from './post_gepa_eval.ts';
export type { EvaluateCandidateOpts } from './post_gepa_eval.ts';

export { validateEvalCases } from './eval_cases.ts';
export type { EvalCasesValidation } from './eval_cases.ts';

export {
  EDIT_LEDGER,
  REJECTED_EDITS,
  appendEditLedgerRecords,
  appendRejectedEditRecords,
  loadRejectedFingerprints,
  toEditLedgerRecords,
  toRejectedEditRecords,
} from './ledger.ts';
export type { EditLedgerRecord } from './ledger.ts';

export { promotionPlanFromEval } from './promotion.ts';
export type { PromotionPlan } from './promotion.ts';
