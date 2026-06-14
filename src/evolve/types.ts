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

export const MAX_OBSERVATION_FIELD_CHARS = 2048;

const SECRET_SHAPES = [
  /sk-ant-[a-zA-Z0-9-]{8,}/,
  /sk-proj-[a-zA-Z0-9_-]{8,}/,
  /\bsk-[a-zA-Z0-9][a-zA-Z0-9_-]{15,}\b/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
] as const;

export interface ObservationValidationOk {
  readonly ok: true;
  readonly value: RawObservation;
}

export interface ObservationValidationErr {
  readonly ok: false;
  readonly reason: string;
}

export type ObservationValidation = ObservationValidationOk | ObservationValidationErr;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, field: string): string | ObservationValidationErr {
  if (typeof value !== 'string') return { ok: false, reason: `${field} must be a string` };
  const text = value.trim();
  if (text === '') return { ok: false, reason: `${field} must be non-empty` };
  if (text.length > MAX_OBSERVATION_FIELD_CHARS) {
    return { ok: false, reason: `${field} exceeds ${MAX_OBSERVATION_FIELD_CHARS} characters` };
  }
  return value;
}

function hasSecretShape(text: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(text));
}

function validSkillId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
}

export function validateRawObservation(value: unknown): ObservationValidation {
  if (!isObject(value)) return { ok: false, reason: 'observation must be an object' };
  const kind = value['kind'];
  if (typeof kind !== 'string' || !isObservationKind(kind)) return { ok: false, reason: 'unknown observation kind' };

  const summary = cleanString(value['summary'], 'summary');
  if (typeof summary !== 'string') return summary;

  if (kind === 'friction') {
    const constraint = cleanString(value['constraint'], 'constraint');
    if (typeof constraint !== 'string') return constraint;
    return { ok: true, value: { kind, summary, constraint } };
  }

  if (kind === 'rubric_drift') {
    const rubric = cleanString(value['rubric'], 'rubric');
    if (typeof rubric !== 'string') return rubric;
    const guidance = cleanString(value['guidance'], 'guidance');
    if (typeof guidance !== 'string') return guidance;
    return { ok: true, value: { kind, summary, rubric, guidance } };
  }

  if (kind === 'missing_skill') {
    const skill = cleanString(value['skill'], 'skill');
    if (typeof skill !== 'string') return skill;
    if (!validSkillId(skill)) return { ok: false, reason: 'skill must be a simple skill id' };
    return { ok: true, value: { kind, summary, skill } };
  }

  const fact = cleanString(value['fact'], 'fact');
  if (typeof fact !== 'string') return fact;
  if (hasSecretShape(fact)) return { ok: false, reason: 'memory fact looks like a secret' };
  const level = value['level'];
  if (typeof level !== 'string' || !isMemoryLevel(level)) return { ok: false, reason: 'memory level must be l1, l2, or l3' };
  return { ok: true, value: { kind, summary, fact, level } };
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

export type ArtifactKind =
  | 'prompt_persona'
  | 'rubric'
  | 'validator'
  | 'skill'
  | 'team_config'
  | 'memory_policy'
  | 'source_patch';

export interface EvolutionMetric {
  readonly candidateId: string;
  readonly name: 'token_delta' | 'cost_usd' | 'latency_ms' | 'hard_validator_pass';
  readonly value: number;
}

export interface EvolutionDecision {
  readonly candidateId: string;
  readonly artifact: ArtifactKind;
  readonly verdict: 'accepted' | 'rejected';
  readonly reasons: readonly string[];
}

export interface ActivationEvidence {
  readonly candidateId: string;
  readonly artifact: ArtifactKind;
  readonly surface: 'system_prompt' | 'rubric_prompt' | 'hard_validator' | 'skill_registry' | 'team_config' | 'memory_file';
  readonly target: string;
}

export interface EvolutionRun {
  readonly schema: 1;
  readonly id: string;
  readonly created: string;
  readonly baselineVersion: string;
  readonly candidateIds: readonly string[];
  readonly datasetIds: readonly string[];
  readonly metrics: readonly EvolutionMetric[];
  readonly constraints: readonly string[];
  readonly provenance: Readonly<Record<string, readonly string[]>>;
  readonly decisions: readonly EvolutionDecision[];
  readonly activationEvidence: readonly ActivationEvidence[];
}

export const PROPOSER_KINDS = Object.freeze([
  'human',
  'gepa',
  'skillopt_style',
  'spear_style',
  'contraprompt_style',
  'rho',
  'life_harness_style',
] as const);
export type ProposerKind = (typeof PROPOSER_KINDS)[number];

export const FAILURE_LAYERS = Object.freeze([
  'prompt',
  'skill',
  'rubric',
  'memory',
  'tool_schema',
  'validator',
  'permission',
  'trajectory',
  'cost',
  'unknown',
] as const);
export type FailureLayer = (typeof FAILURE_LAYERS)[number];

export const ATOMIC_EDIT_OPERATIONS = Object.freeze(['add', 'delete', 'replace'] as const);
export type AtomicEditOperation = (typeof ATOMIC_EDIT_OPERATIONS)[number];

export const EVAL_SUITES = Object.freeze(['train', 'selection', 'holdout', 'safety', 'activation', 'canary', 'aging'] as const);
export type EvalSuite = (typeof EVAL_SUITES)[number];

export interface CandidateProposer {
  readonly kind: ProposerKind;
  readonly version: string;
  readonly model?: string;
}

export interface CandidateDiagnosis {
  readonly failureLayer: FailureLayer;
  readonly userGoal?: string;
  readonly evidenceIds: readonly string[];
  readonly summary: string;
}

export interface MetricPrediction {
  readonly metric: string;
  readonly deltaMin: number;
}

export interface EditRollback {
  readonly type: 'preimage_hash' | 'inverse_patch';
  readonly value: string;
}

export interface AtomicEdit {
  readonly editId: string;
  readonly target: string;
  readonly operation: AtomicEditOperation;
  readonly bounded: boolean;
  readonly text: string;
  readonly diagnosis: string;
  readonly prediction: MetricPrediction;
  readonly risks: readonly string[];
  readonly activationPath: readonly string[];
  readonly rollback: EditRollback;
}

export interface ParetoMetadata {
  readonly frontierRank: number;
  readonly dominated: boolean;
  readonly objectives: Readonly<Record<string, number>>;
}

export interface CandidateBundle {
  readonly schema: 1;
  readonly candidateId: string;
  readonly harnessId: string;
  readonly harnessDomain: string;
  readonly parentPackVersion: string;
  readonly proposer: CandidateProposer;
  readonly diagnosis: CandidateDiagnosis;
  readonly atomicEdits: readonly AtomicEdit[];
  readonly requiredEvalSuites: readonly EvalSuite[];
  readonly pareto?: ParetoMetadata;
  readonly notes?: string;
}

export interface EvidenceContract {
  readonly primaryMetrics: readonly string[];
  readonly domainMetrics: readonly string[];
  readonly guardMetrics: readonly string[];
  readonly activationMetrics: readonly string[];
  readonly promotionRule: 'strict_holdout_improvement_and_no_guard_regression';
  readonly costBudget: {
    readonly maxTokenDeltaRatio: number;
    readonly maxLatencyDeltaRatio: number;
  };
}

export interface EvalMetricSnapshot {
  readonly verifiedSuccess: number;
  readonly permissionSafety: number;
  readonly illegalActionRate: number;
  readonly cost: number;
  readonly latencyMs: number;
  readonly activatedEdits?: readonly string[];
  readonly benefitedEdits?: readonly string[];
}

export interface EditAblationResult {
  readonly verifiedSuccessDelta: number;
  readonly guardRegression: boolean;
  readonly activated: boolean;
  readonly benefited: boolean;
}

export interface EvalCase {
  readonly id: string;
  readonly harnessId: string;
  readonly suite: EvalSuite;
  readonly baseline: EvalMetricSnapshot;
  readonly candidate: EvalMetricSnapshot;
  readonly ablations?: Readonly<Record<string, EditAblationResult>>;
}

export interface EvalReportMetrics {
  readonly holdoutDelta: number;
  readonly guardRegressionCount: number;
  readonly activationRate: number;
  readonly benefitRate: number;
  readonly costDeltaRatio: number;
  readonly latencyDeltaRatio: number;
}

export interface EvalPromotionDecision {
  readonly verdict: 'accepted' | 'partial' | 'rejected';
  readonly reasons: readonly string[];
  readonly acceptedEditIds: readonly string[];
  readonly rejectedEditIds: readonly string[];
}

export interface CandidateEvalReport {
  readonly schema: 1;
  readonly candidateId: string;
  readonly harnessId: string;
  readonly harnessDomain: string;
  readonly metrics: EvalReportMetrics;
  readonly decision: EvalPromotionDecision;
  readonly research: {
    readonly retainedOnParetoFrontier: boolean;
  };
}

export interface RejectedEditRecord {
  readonly schema: 1;
  readonly candidateId: string;
  readonly editId: string;
  readonly harnessId: string;
  readonly harnessDomain: string;
  readonly fingerprint: string;
  readonly reasons: readonly string[];
}
