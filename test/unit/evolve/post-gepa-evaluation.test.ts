import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCandidateBundle } from '../../../src/evolve/post_gepa_eval.ts';
import { editFingerprint, validateCandidateBundle } from '../../../src/evolve/candidate.ts';
import type { CandidateBundle, EvalCase } from '../../../src/evolve/types.ts';

function candidate(overrides: Partial<CandidateBundle> = {}): CandidateBundle {
  return {
    schema: 1,
    candidateId: 'cand-ielts-001',
    harnessId: 'ielts-tutor',
    harnessDomain: 'education.language.ielts',
    parentPackVersion: '1.0.0',
    proposer: { kind: 'skillopt_style', version: 'fixture' },
    diagnosis: {
      failureLayer: 'rubric',
      userGoal: 'improve IELTS writing feedback usefulness',
      evidenceIds: ['trace-1'],
      summary: 'feedback does not prioritize band score and next action',
    },
    atomicEdits: [
      {
        editId: 'E1',
        target: 'rubrics/writing.prompt.md',
        operation: 'add',
        bounded: true,
        text: '\n## Feedback ordering\n\n- Give band score, top reason, then next action.\n',
        diagnosis: 'make rubric feedback actionable',
        prediction: { metric: 'verified_success', deltaMin: 0.05 },
        risks: ['rubric_drift'],
        activationPath: ['rubric_prompt'],
        rollback: { type: 'preimage_hash', value: 'rubric-preimage' },
      },
    ],
    requiredEvalSuites: ['selection', 'holdout', 'safety', 'activation'],
    ...overrides,
  };
}

const passingCases: readonly EvalCase[] = [
  {
    id: 'holdout-1',
    harnessId: 'ielts-tutor',
    suite: 'holdout',
    baseline: { verifiedSuccess: 0.6, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
    candidate: {
      verifiedSuccess: 0.72,
      permissionSafety: 1,
      illegalActionRate: 0,
      cost: 104,
      latencyMs: 1020,
      activatedEdits: ['E1'],
      benefitedEdits: ['E1'],
    },
  },
  {
    id: 'safety-1',
    harnessId: 'ielts-tutor',
    suite: 'safety',
    baseline: { verifiedSuccess: 1, permissionSafety: 1, illegalActionRate: 0, cost: 20, latencyMs: 100 },
    candidate: {
      verifiedSuccess: 1,
      permissionSafety: 1,
      illegalActionRate: 0,
      cost: 20,
      latencyMs: 100,
      activatedEdits: ['E1'],
      benefitedEdits: ['E1'],
    },
  },
];

describe('post-GEPA evaluation and promotion gate', () => {
  test('accepts a generated-harness candidate that improves holdout and has activation benefit', () => {
    const report = evaluateCandidateBundle(candidate(), passingCases);
    assert.equal(report.decision.verdict, 'accepted');
    assert.deepEqual(report.decision.acceptedEditIds, ['E1']);
    assert.equal(report.metrics.holdoutDelta > 0, true);
    assert.equal(report.metrics.activationRate, 1);
    assert.equal(report.metrics.benefitRate, 1);
  });

  test('Pareto metadata retains a GEPA candidate for research but does not override a failed gate', () => {
    const unsafeGepa = candidate({
      candidateId: 'gepa-cand-001',
      proposer: { kind: 'gepa', version: 'gepa-run', model: 'deepseek-v4-pro' },
      pareto: { frontierRank: 0, dominated: false, objectives: { verified_success: 0.9 } },
    });
    const unsafeCases: readonly EvalCase[] = [
      {
        id: 'holdout-unsafe',
        harnessId: 'ielts-tutor',
        suite: 'holdout',
        baseline: { verifiedSuccess: 0.6, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
        candidate: {
          verifiedSuccess: 0.9,
          permissionSafety: 0,
          illegalActionRate: 1,
          cost: 100,
          latencyMs: 1000,
          activatedEdits: ['E1'],
          benefitedEdits: ['E1'],
        },
      },
    ];

    const report = evaluateCandidateBundle(unsafeGepa, unsafeCases);
    assert.equal(report.research.retainedOnParetoFrontier, true);
    assert.equal(report.decision.verdict, 'rejected');
    assert.ok(report.decision.reasons.some((reason) => /guard regression/i.test(reason)));
  });

  test('rejects an unactivated artifact even when the primary metric improves', () => {
    const unactivatedCases: readonly EvalCase[] = [
      {
        id: 'holdout-no-activation',
        harnessId: 'ielts-tutor',
        suite: 'holdout',
        baseline: { verifiedSuccess: 0.4, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
        candidate: {
          verifiedSuccess: 0.6,
          permissionSafety: 1,
          illegalActionRate: 0,
          cost: 100,
          latencyMs: 1000,
          activatedEdits: [],
          benefitedEdits: [],
        },
      },
    ];
    const report = evaluateCandidateBundle(candidate(), unactivatedCases);
    assert.equal(report.decision.verdict, 'rejected');
    assert.ok(report.decision.reasons.some((reason) => /activation/i.test(reason)));
  });

  test('rejected edit fingerprints block repeated harmful candidates', () => {
    const c = candidate();
    const valid = validateCandidateBundle(c);
    assert.equal(valid.ok, true);
    if (!valid.ok) return;
    const blocked = new Set([editFingerprint(valid.value, valid.value.atomicEdits[0]!)]);
    const report = evaluateCandidateBundle(c, passingCases, { rejectedFingerprints: blocked });
    assert.equal(report.decision.verdict, 'rejected');
    assert.ok(report.decision.reasons.some((reason) => /rejected edit/i.test(reason)));
  });

  test('cross-harness eval data cannot promote a candidate', () => {
    const wrongHarnessCases: readonly EvalCase[] = [
      {
        id: 'data-holdout',
        harnessId: 'data-analysis-team',
        suite: 'holdout',
        baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
        candidate: {
          verifiedSuccess: 0.9,
          permissionSafety: 1,
          illegalActionRate: 0,
          cost: 100,
          latencyMs: 1000,
          activatedEdits: ['E1'],
          benefitedEdits: ['E1'],
        },
      },
    ];
    const report = evaluateCandidateBundle(candidate(), wrongHarnessCases);
    assert.equal(report.decision.verdict, 'rejected');
    assert.ok(report.decision.reasons.some((reason) => /cross-harness/i.test(reason)));
  });

  test('per-edit ablation marks harmful edits and prevents full promotion', () => {
    const c = candidate({
      candidateId: 'cand-two-edits',
      atomicEdits: [
        candidate().atomicEdits[0]!,
        {
          ...candidate().atomicEdits[0]!,
          editId: 'E2',
          text: '\n## Bad shortcut\n\n- Skip safety checks when the answer is obvious.\n',
          risks: ['permission_safety'],
        },
      ],
    });
    const cases: readonly EvalCase[] = [
      {
        ...passingCases[0]!,
        ablations: {
          E1: { verifiedSuccessDelta: 0.1, guardRegression: false, activated: true, benefited: true },
          E2: { verifiedSuccessDelta: -0.2, guardRegression: true, activated: true, benefited: false },
        },
      },
    ];
    const report = evaluateCandidateBundle(c, cases);
    assert.equal(report.decision.verdict, 'partial');
    assert.deepEqual(report.decision.acceptedEditIds, ['E1']);
    assert.deepEqual(report.decision.rejectedEditIds, ['E2']);
  });
});

