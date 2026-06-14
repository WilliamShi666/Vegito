import type {
  CandidateBundle,
  CandidateEvalReport,
  EvalCase,
  EvalMetricSnapshot,
  EvalReportMetrics,
} from './types.ts';
import { defaultEvidenceContract, editFingerprint, validateCandidateBundle } from './candidate.ts';

export interface EvaluateCandidateOpts {
  readonly rejectedFingerprints?: ReadonlySet<string>;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratioDelta(baseline: number, candidate: number): number {
  if (baseline === 0) return candidate === 0 ? 0 : 1;
  return (candidate - baseline) / baseline;
}

function hasGuardRegression(baseline: EvalMetricSnapshot, candidate: EvalMetricSnapshot): boolean {
  return candidate.permissionSafety < baseline.permissionSafety || candidate.illegalActionRate > baseline.illegalActionRate;
}

function uniqueIds(cases: readonly EvalCase[], key: 'activatedEdits' | 'benefitedEdits'): ReadonlySet<string> {
  const out = new Set<string>();
  for (const item of cases) {
    for (const id of item.candidate[key] ?? []) out.add(id);
  }
  return out;
}

function editRate(edits: readonly string[], cases: readonly EvalCase[], key: 'activatedEdits' | 'benefitedEdits'): number {
  if (edits.length === 0) return 0;
  const seen = uniqueIds(cases, key);
  return edits.filter((editId) => seen.has(editId)).length / edits.length;
}

function reportMetrics(candidate: CandidateBundle, cases: readonly EvalCase[]): EvalReportMetrics {
  const holdout = cases.filter((item) => item.suite === 'holdout');
  const holdoutDelta = average(holdout.map((item) => item.candidate.verifiedSuccess - item.baseline.verifiedSuccess));
  const guardRegressionCount = cases.filter((item) => hasGuardRegression(item.baseline, item.candidate)).length;
  const activated = uniqueIds(cases, 'activatedEdits');
  const benefited = uniqueIds(cases, 'benefitedEdits');
  const editCount = candidate.atomicEdits.length;
  const activationRate = editCount === 0 ? 0 : candidate.atomicEdits.filter((edit) => activated.has(edit.editId)).length / editCount;
  const benefitRate = editCount === 0 ? 0 : candidate.atomicEdits.filter((edit) => benefited.has(edit.editId)).length / editCount;
  const costDeltaRatio = average(cases.map((item) => ratioDelta(item.baseline.cost, item.candidate.cost)));
  const latencyDeltaRatio = average(cases.map((item) => ratioDelta(item.baseline.latencyMs, item.candidate.latencyMs)));
  return {
    holdoutDelta,
    guardRegressionCount,
    activationRate,
    benefitRate,
    costDeltaRatio,
    latencyDeltaRatio,
  };
}

function harnessCases(candidate: CandidateBundle, cases: readonly EvalCase[]): readonly EvalCase[] {
  return cases.filter((item) => item.harnessId === candidate.harnessId);
}

function allCasesAreCrossHarness(candidate: CandidateBundle, cases: readonly EvalCase[]): boolean {
  return cases.length > 0 && harnessCases(candidate, cases).length === 0;
}

function ablationDecision(candidate: CandidateBundle, cases: readonly EvalCase[]): {
  readonly acceptedEditIds: readonly string[];
  readonly rejectedEditIds: readonly string[];
  readonly hasAblation: boolean;
} {
  const ablations = cases.flatMap((item) =>
    item.ablations === undefined
      ? []
      : Object.entries(item.ablations).map(([editId, result]) => ({ editId, result })),
  );
  if (ablations.length === 0) {
    return {
      acceptedEditIds: candidate.atomicEdits.map((edit) => edit.editId),
      rejectedEditIds: [],
      hasAblation: false,
    };
  }
  const harmful = new Set(
    ablations
      .filter(({ result }) => result.guardRegression || result.verifiedSuccessDelta < 0 || !result.benefited)
      .map(({ editId }) => editId),
  );
  return {
    acceptedEditIds: candidate.atomicEdits.map((edit) => edit.editId).filter((id) => !harmful.has(id)),
    rejectedEditIds: [...harmful],
    hasAblation: true,
  };
}

export function evaluateCandidateBundle(
  rawCandidate: CandidateBundle,
  allCases: readonly EvalCase[],
  opts: EvaluateCandidateOpts = {},
): CandidateEvalReport {
  const validated = validateCandidateBundle(rawCandidate);
  if (!validated.ok) {
    return {
      schema: 1,
      candidateId: rawCandidate.candidateId,
      harnessId: rawCandidate.harnessId,
      harnessDomain: rawCandidate.harnessDomain,
      metrics: {
        holdoutDelta: 0,
        guardRegressionCount: 0,
        activationRate: 0,
        benefitRate: 0,
        costDeltaRatio: 0,
        latencyDeltaRatio: 0,
      },
      decision: {
        verdict: 'rejected',
        reasons: [validated.reason],
        acceptedEditIds: [],
        rejectedEditIds: [],
      },
      research: { retainedOnParetoFrontier: rawCandidate.pareto?.dominated === false },
    };
  }
  const candidate = validated.value;
  const contract = defaultEvidenceContract(candidate.harnessDomain);
  const cases = harnessCases(candidate, allCases);
  const metrics = reportMetrics(candidate, cases);
  const reasons: string[] = [];

  if (allCasesAreCrossHarness(candidate, allCases)) {
    reasons.push('cross-harness eval data cannot promote this generated harness candidate');
  }
  if (!cases.some((item) => item.suite === 'holdout')) reasons.push('missing holdout suite');
  if (metrics.holdoutDelta <= 0) reasons.push('holdout primary metric did not improve');
  if (metrics.guardRegressionCount > 0) reasons.push('guard regression detected');
  if (metrics.costDeltaRatio > contract.costBudget.maxTokenDeltaRatio) reasons.push('cost budget exceeded');
  if (metrics.latencyDeltaRatio > contract.costBudget.maxLatencyDeltaRatio) reasons.push('latency budget exceeded');
  const blocked = candidate.atomicEdits.filter((edit) => opts.rejectedFingerprints?.has(editFingerprint(candidate, edit)));
  if (blocked.length > 0) reasons.push('candidate repeats a rejected edit fingerprint');

  const ablation = ablationDecision(candidate, cases);
  const evaluatedEditIds = ablation.hasAblation ? ablation.acceptedEditIds : candidate.atomicEdits.map((edit) => edit.editId);
  if (editRate(evaluatedEditIds, cases, 'activatedEdits') < 1) reasons.push('activation evidence is incomplete');
  if (editRate(evaluatedEditIds, cases, 'benefitedEdits') < 1) reasons.push('benefit evidence is incomplete');
  if (ablation.rejectedEditIds.length > 0) reasons.push('per-edit ablation found harmful edits');

  const retainedOnParetoFrontier = candidate.pareto?.dominated === false;
  const verdict =
    reasons.length === 0
      ? 'accepted'
      : ablation.hasAblation && ablation.acceptedEditIds.length > 0 && reasons.every((reason) => /ablation/i.test(reason))
        ? 'partial'
        : 'rejected';

  return {
    schema: 1,
    candidateId: candidate.candidateId,
    harnessId: candidate.harnessId,
    harnessDomain: candidate.harnessDomain,
    metrics,
    decision: {
      verdict,
      reasons,
      acceptedEditIds: verdict === 'rejected' ? [] : ablation.acceptedEditIds,
      rejectedEditIds: ablation.rejectedEditIds,
    },
    research: { retainedOnParetoFrontier },
  };
}
