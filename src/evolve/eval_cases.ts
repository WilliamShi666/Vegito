import type { EditAblationResult, EvalCase, EvalMetricSnapshot, EvalSuite } from './types.ts';
import { EVAL_SUITES } from './types.ts';

export interface EvalCasesValidationOk {
  readonly ok: true;
  readonly value: readonly EvalCase[];
}

export interface EvalCasesValidationErr {
  readonly ok: false;
  readonly reason: string;
}

export type EvalCasesValidation = EvalCasesValidationOk | EvalCasesValidationErr;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown, field: string): string | EvalCasesValidationErr {
  if (typeof value !== 'string') return { ok: false, reason: `${field} must be a string` };
  if (value.trim() === '') return { ok: false, reason: `${field} must be non-empty` };
  return value;
}

function cleanNumber(value: unknown, field: string): number | EvalCasesValidationErr {
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, reason: `${field} must be a finite number` };
  return value;
}

function cleanStringArray(value: unknown, field: string): readonly string[] | EvalCasesValidationErr {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return { ok: false, reason: `${field} must be an array` };
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return { ok: false, reason: `${field} must contain non-empty strings` };
    out.push(item);
  }
  return out;
}

function isValidationErr(value: unknown): value is EvalCasesValidationErr {
  return isObject(value) && value['ok'] === false && typeof value['reason'] === 'string';
}

function parseSnapshot(value: unknown, field: string): EvalMetricSnapshot | EvalCasesValidationErr {
  if (!isObject(value)) return { ok: false, reason: `${field} must be an object` };
  const verifiedSuccess = cleanNumber(value['verifiedSuccess'], `${field}.verifiedSuccess`);
  if (typeof verifiedSuccess !== 'number') return verifiedSuccess;
  const permissionSafety = cleanNumber(value['permissionSafety'], `${field}.permissionSafety`);
  if (typeof permissionSafety !== 'number') return permissionSafety;
  const illegalActionRate = cleanNumber(value['illegalActionRate'], `${field}.illegalActionRate`);
  if (typeof illegalActionRate !== 'number') return illegalActionRate;
  const cost = cleanNumber(value['cost'], `${field}.cost`);
  if (typeof cost !== 'number') return cost;
  const latencyMs = cleanNumber(value['latencyMs'], `${field}.latencyMs`);
  if (typeof latencyMs !== 'number') return latencyMs;
  const activatedEdits = cleanStringArray(value['activatedEdits'], `${field}.activatedEdits`);
  if (isValidationErr(activatedEdits)) return activatedEdits;
  const benefitedEdits = cleanStringArray(value['benefitedEdits'], `${field}.benefitedEdits`);
  if (isValidationErr(benefitedEdits)) return benefitedEdits;

  return {
    verifiedSuccess,
    permissionSafety,
    illegalActionRate,
    cost,
    latencyMs,
    ...(activatedEdits.length === 0 ? {} : { activatedEdits }),
    ...(benefitedEdits.length === 0 ? {} : { benefitedEdits }),
  };
}

function parseAblation(value: unknown, field: string): EditAblationResult | EvalCasesValidationErr {
  if (!isObject(value)) return { ok: false, reason: `${field} must be an object` };
  const verifiedSuccessDelta = cleanNumber(value['verifiedSuccessDelta'], `${field}.verifiedSuccessDelta`);
  if (typeof verifiedSuccessDelta !== 'number') return verifiedSuccessDelta;
  if (typeof value['guardRegression'] !== 'boolean') return { ok: false, reason: `${field}.guardRegression must be boolean` };
  if (typeof value['activated'] !== 'boolean') return { ok: false, reason: `${field}.activated must be boolean` };
  if (typeof value['benefited'] !== 'boolean') return { ok: false, reason: `${field}.benefited must be boolean` };
  return {
    verifiedSuccessDelta,
    guardRegression: value['guardRegression'],
    activated: value['activated'],
    benefited: value['benefited'],
  };
}

function parseAblations(value: unknown, field: string): Readonly<Record<string, EditAblationResult>> | undefined | EvalCasesValidationErr {
  if (value === undefined) return undefined;
  if (!isObject(value)) return { ok: false, reason: `${field} must be an object` };
  const out: Record<string, EditAblationResult> = {};
  for (const [editId, raw] of Object.entries(value)) {
    if (editId.trim() === '') return { ok: false, reason: `${field} edit id must be non-empty` };
    const parsed = parseAblation(raw, `${field}.${editId}`);
    if (isValidationErr(parsed)) return parsed;
    out[editId] = parsed;
  }
  return out;
}

function isEvalSuite(value: string): value is EvalSuite {
  return (EVAL_SUITES as readonly string[]).includes(value);
}

function parseCase(value: unknown, index: number): EvalCase | EvalCasesValidationErr {
  const field = `evalCases[${index}]`;
  if (!isObject(value)) return { ok: false, reason: `${field} must be an object` };
  const id = cleanString(value['id'], `${field}.id`);
  if (typeof id !== 'string') return id;
  const harnessId = cleanString(value['harnessId'], `${field}.harnessId`);
  if (typeof harnessId !== 'string') return harnessId;
  const suite = cleanString(value['suite'], `${field}.suite`);
  if (typeof suite !== 'string') return suite;
  if (!isEvalSuite(suite)) return { ok: false, reason: `${field}.suite is unknown` };
  const baseline = parseSnapshot(value['baseline'], `${field}.baseline`);
  if (isValidationErr(baseline)) return baseline;
  const candidate = parseSnapshot(value['candidate'], `${field}.candidate`);
  if (isValidationErr(candidate)) return candidate;
  const ablations = parseAblations(value['ablations'], `${field}.ablations`);
  if (ablations !== undefined && isValidationErr(ablations)) return ablations;
  return {
    id,
    harnessId,
    suite,
    baseline,
    candidate,
    ...(ablations === undefined ? {} : { ablations }),
  };
}

export function validateEvalCases(value: unknown): EvalCasesValidation {
  if (!Array.isArray(value)) return { ok: false, reason: 'evalCases must be a JSON array' };
  const cases = value.map((item, index) => parseCase(item, index));
  const problem = cases.find(isValidationErr);
  if (problem !== undefined) return problem;
  return { ok: true, value: Object.freeze(cases as readonly EvalCase[]) };
}
