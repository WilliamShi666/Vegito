import { createHash } from 'node:crypto';
import { isAbsolute, posix } from 'node:path';

import type {
  AtomicEdit,
  CandidateBundle,
  EvidenceContract,
  EvalSuite,
  FailureLayer,
  Proposal,
  ProposerKind,
} from './types.ts';
import {
  ATOMIC_EDIT_OPERATIONS,
  EVAL_SUITES,
  FAILURE_LAYERS,
  PROPOSER_KINDS,
} from './types.ts';

export interface CandidateValidationOk {
  readonly ok: true;
  readonly value: CandidateBundle;
}

export interface CandidateValidationErr {
  readonly ok: false;
  readonly reason: string;
}

export type CandidateValidation = CandidateValidationOk | CandidateValidationErr;

const SYSTEM_OWNED = ['pack.json', '.evolve'];
const MAX_BOUNDED_EDIT_CHARS = 8_192;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, field: string): string | CandidateValidationErr {
  if (typeof value !== 'string') return { ok: false, reason: `${field} must be a string` };
  if (value.trim() === '') return { ok: false, reason: `${field} must be non-empty` };
  return value;
}

function cleanStringArray(value: unknown, field: string): readonly string[] | CandidateValidationErr {
  if (!Array.isArray(value)) return { ok: false, reason: `${field} must be an array` };
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return { ok: false, reason: `${field} must contain non-empty strings` };
    out.push(item);
  }
  return out;
}

function isValidationErr(value: unknown): value is CandidateValidationErr {
  return isObject(value) && value['ok'] === false && typeof value['reason'] === 'string';
}

function cleanNumber(value: unknown, field: string): number | CandidateValidationErr {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `${field} must be a finite number` };
  return value;
}

function cleanRel(raw: string): string | undefined {
  const unix = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (unix === '' || unix === '.') return undefined;
  if (isAbsolute(raw) || posix.isAbsolute(unix)) return undefined;
  const norm = posix.normalize(unix);
  if (norm === '.' || norm === '..' || norm.startsWith('../')) return undefined;
  return norm;
}

function isSystemOwned(rel: string): boolean {
  return SYSTEM_OWNED.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

function isProposerKind(value: string): value is ProposerKind {
  return (PROPOSER_KINDS as readonly string[]).includes(value);
}

function isFailureLayer(value: string): value is FailureLayer {
  return (FAILURE_LAYERS as readonly string[]).includes(value);
}

function isEvalSuite(value: string): value is EvalSuite {
  return (EVAL_SUITES as readonly string[]).includes(value);
}

function parseProposer(value: unknown): CandidateBundle['proposer'] | CandidateValidationErr {
  if (!isObject(value)) return { ok: false, reason: 'proposer must be an object' };
  const kind = value['kind'];
  if (typeof kind !== 'string' || !isProposerKind(kind)) return { ok: false, reason: 'unknown proposer kind' };
  const version = cleanString(value['version'], 'proposer.version');
  if (typeof version !== 'string') return version;
  const model = value['model'];
  return model === undefined
    ? { kind, version }
    : typeof model === 'string'
      ? { kind, version, model }
      : { ok: false, reason: 'proposer.model must be a string' };
}

function parseDiagnosis(value: unknown): CandidateBundle['diagnosis'] | CandidateValidationErr {
  if (!isObject(value)) return { ok: false, reason: 'diagnosis must be an object' };
  const layer = value['failureLayer'];
  if (typeof layer !== 'string' || !isFailureLayer(layer)) return { ok: false, reason: 'diagnosis.failureLayer is unknown' };
  const evidenceIds = cleanStringArray(value['evidenceIds'], 'diagnosis.evidenceIds');
  if (isValidationErr(evidenceIds)) return evidenceIds;
  const summary = cleanString(value['summary'], 'diagnosis.summary');
  if (typeof summary !== 'string') return summary;
  const userGoal = value['userGoal'];
  return userGoal === undefined
    ? { failureLayer: layer, evidenceIds, summary }
    : typeof userGoal === 'string'
      ? { failureLayer: layer, userGoal, evidenceIds, summary }
      : { ok: false, reason: 'diagnosis.userGoal must be a string' };
}

function parseAtomicEdit(value: unknown): AtomicEdit | CandidateValidationErr {
  if (!isObject(value)) return { ok: false, reason: 'atomic edit must be an object' };
  const editId = cleanString(value['editId'], 'editId');
  if (typeof editId !== 'string') return editId;
  const target = cleanString(value['target'], `edit ${editId} target`);
  if (typeof target !== 'string') return target;
  const rel = cleanRel(target);
  if (rel === undefined) return { ok: false, reason: `unsafe edit target: ${target}` };
  if (isSystemOwned(rel)) return { ok: false, reason: `system-owned target cannot be edited by candidate: ${rel}` };
  const operation = value['operation'];
  if (typeof operation !== 'string') return { ok: false, reason: `edit ${editId} operation must be a string` };
  if (!(ATOMIC_EDIT_OPERATIONS as readonly string[]).includes(operation)) {
    return { ok: false, reason: `unsupported operation for MVP: ${operation}; source patches are excluded from MVP` };
  }
  const op = operation as AtomicEdit['operation'];
  const bounded = value['bounded'];
  if (typeof bounded !== 'boolean') return { ok: false, reason: `edit ${editId} bounded must be boolean` };
  const text = cleanString(value['text'], `edit ${editId} text`);
  if (typeof text !== 'string') return text;
  if (bounded && text.length > MAX_BOUNDED_EDIT_CHARS) return { ok: false, reason: `edit ${editId} exceeds bounded edit size` };
  const diagnosis = cleanString(value['diagnosis'], `edit ${editId} diagnosis`);
  if (typeof diagnosis !== 'string') return diagnosis;
  const prediction = isObject(value['prediction']) ? value['prediction'] : undefined;
  if (prediction === undefined) return { ok: false, reason: `edit ${editId} prediction must be an object` };
  const metric = cleanString(prediction['metric'], `edit ${editId} prediction.metric`);
  if (typeof metric !== 'string') return metric;
  const deltaMin = cleanNumber(prediction['deltaMin'], `edit ${editId} prediction.deltaMin`);
  if (typeof deltaMin !== 'number') return deltaMin;
  const risks = cleanStringArray(value['risks'] ?? [], `edit ${editId} risks`);
  if (isValidationErr(risks)) return risks;
  const activationPath = cleanStringArray(value['activationPath'] ?? [], `edit ${editId} activationPath`);
  if (isValidationErr(activationPath)) return activationPath;
  const rollback = isObject(value['rollback']) ? value['rollback'] : undefined;
  if (rollback === undefined) return { ok: false, reason: `edit ${editId} rollback must be an object` };
  const rollbackType = rollback['type'];
  if (rollbackType !== 'preimage_hash' && rollbackType !== 'inverse_patch') return { ok: false, reason: `edit ${editId} rollback.type is invalid` };
  const rollbackValue = cleanString(rollback['value'], `edit ${editId} rollback.value`);
  if (typeof rollbackValue !== 'string') return rollbackValue;

  return {
    editId,
    target: rel,
    operation: op,
    bounded,
    text,
    diagnosis,
    prediction: { metric, deltaMin },
    risks,
    activationPath,
    rollback: { type: rollbackType, value: rollbackValue },
  };
}

function parsePareto(value: unknown): CandidateBundle['pareto'] | CandidateValidationErr {
  if (value === undefined) return undefined;
  if (!isObject(value)) return { ok: false, reason: 'pareto must be an object' };
  const frontierRank = cleanNumber(value['frontierRank'], 'pareto.frontierRank');
  if (typeof frontierRank !== 'number') return frontierRank;
  if (typeof value['dominated'] !== 'boolean') return { ok: false, reason: 'pareto.dominated must be boolean' };
  if (!isObject(value['objectives'])) return { ok: false, reason: 'pareto.objectives must be an object' };
  const objectives: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value['objectives'])) {
    const metric = cleanNumber(raw, `pareto.objectives.${key}`);
    if (typeof metric !== 'number') return metric;
    objectives[key] = metric;
  }
  return { frontierRank, dominated: value['dominated'], objectives };
}

export function validateCandidateBundle(value: unknown): CandidateValidation {
  if (!isObject(value)) return { ok: false, reason: 'candidate must be an object' };
  if (value['schema'] !== 1) return { ok: false, reason: 'candidate schema must be 1' };
  const candidateId = cleanString(value['candidateId'], 'candidateId');
  if (typeof candidateId !== 'string') return candidateId;
  const harnessId = cleanString(value['harnessId'], 'harnessId');
  if (typeof harnessId !== 'string') return harnessId;
  const harnessDomain = cleanString(value['harnessDomain'], 'harnessDomain');
  if (typeof harnessDomain !== 'string') return harnessDomain;
  const parentPackVersion = cleanString(value['parentPackVersion'], 'parentPackVersion');
  if (typeof parentPackVersion !== 'string') return parentPackVersion;
  const proposer = parseProposer(value['proposer']);
  if ('ok' in proposer) return proposer;
  const diagnosis = parseDiagnosis(value['diagnosis']);
  if ('ok' in diagnosis) return diagnosis;
  if (!Array.isArray(value['atomicEdits']) || value['atomicEdits'].length === 0) {
    return { ok: false, reason: 'atomicEdits must be a non-empty array' };
  }
  const atomicEdits: AtomicEdit[] = [];
  const editIds = new Set<string>();
  for (const raw of value['atomicEdits']) {
    const edit = parseAtomicEdit(raw);
    if ('ok' in edit) return edit;
    if (editIds.has(edit.editId)) return { ok: false, reason: `duplicate edit id: ${edit.editId}` };
    editIds.add(edit.editId);
    atomicEdits.push(edit);
  }
  const requiredRaw = cleanStringArray(value['requiredEvalSuites'], 'requiredEvalSuites');
  if (isValidationErr(requiredRaw)) return requiredRaw;
  const requiredEvalSuites: EvalSuite[] = [];
  for (const suite of requiredRaw) {
    if (!isEvalSuite(suite)) return { ok: false, reason: `unknown eval suite: ${suite}` };
    requiredEvalSuites.push(suite);
  }
  const pareto = parsePareto(value['pareto']);
  if (pareto !== undefined && 'ok' in pareto) return pareto;
  const notes = value['notes'];

  return {
    ok: true,
    value: Object.freeze({
      schema: 1,
      candidateId,
      harnessId,
      harnessDomain,
      parentPackVersion,
      proposer,
      diagnosis,
      atomicEdits,
      requiredEvalSuites,
      ...(pareto === undefined ? {} : { pareto }),
      ...(notes === undefined ? {} : { notes: String(notes) }),
    }),
  };
}

export function candidateToProposal(candidate: CandidateBundle, editId: string): Proposal {
  const edit = candidate.atomicEdits.find((item) => item.editId === editId);
  if (edit === undefined) throw new Error(`candidate ${candidate.candidateId} has no edit ${editId}`);
  return {
    kind: 'pack_edit',
    id: `${candidate.candidateId}:${edit.editId}`,
    target: edit.target,
    text: edit.text,
    provenance: candidate.diagnosis.evidenceIds,
  };
}

export function editFingerprint(candidate: CandidateBundle, edit: AtomicEdit): string {
  const canonical = JSON.stringify({
    harnessId: candidate.harnessId,
    harnessDomain: candidate.harnessDomain,
    target: edit.target,
    operation: edit.operation,
    text: edit.text,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function defaultEvidenceContract(_harnessDomain: string): EvidenceContract {
  return {
    primaryMetrics: ['verified_success'],
    domainMetrics: ['user_goal_fit', 'rubric_alignment'],
    guardMetrics: ['permission_safety', 'illegal_action_rate', 'cost', 'latency'],
    activationMetrics: ['artifact_loaded', 'rule_fired', 'memory_used', 'validator_triggered'],
    promotionRule: 'strict_holdout_improvement_and_no_guard_regression',
    costBudget: { maxTokenDeltaRatio: 0.1, maxLatencyDeltaRatio: 0.1 },
  };
}
