import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EDIT_LEDGER,
  REJECTED_EDITS,
  appendEditLedgerRecords,
  appendRejectedEditRecords,
  loadRejectedFingerprints,
  toEditLedgerRecords,
  toRejectedEditRecords,
} from '../../../src/evolve/ledger.ts';
import { evaluateCandidateBundle } from '../../../src/evolve/post_gepa_eval.ts';
import type { CandidateBundle, EvalCase } from '../../../src/evolve/types.ts';

function candidate(): CandidateBundle {
  return {
    schema: 1,
    candidateId: 'cand-ielts-ledger',
    harnessId: 'ielts-tutor',
    harnessDomain: 'education.language.ielts',
    parentPackVersion: '1.0.0',
    proposer: { kind: 'skillopt_style', version: 'fixture' },
    diagnosis: {
      failureLayer: 'skill',
      userGoal: 'improve IELTS feedback',
      evidenceIds: ['trace-ledger'],
      summary: 'feedback lacks next action',
    },
    atomicEdits: [
      {
        editId: 'E1',
        target: 'persona.md',
        operation: 'add',
        bounded: true,
        text: '\n## Feedback order\n\n- Give the next action after the score.\n',
        diagnosis: 'make feedback actionable',
        prediction: { metric: 'verified_success', deltaMin: 0.05 },
        risks: ['rubric_drift'],
        activationPath: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
      {
        editId: 'E2',
        target: 'persona.md',
        operation: 'add',
        bounded: true,
        text: '\n## Unsafe shortcut\n\n- Skip checks to save time.\n',
        diagnosis: 'bad shortcut',
        prediction: { metric: 'latency', deltaMin: 0.1 },
        risks: ['permission_safety'],
        activationPath: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
    ],
    requiredEvalSuites: ['holdout', 'safety', 'activation'],
  };
}

const cases: readonly EvalCase[] = [
  {
    id: 'holdout-ledger',
    harnessId: 'ielts-tutor',
    suite: 'holdout',
    baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
    candidate: {
      verifiedSuccess: 0.6,
      permissionSafety: 1,
      illegalActionRate: 0,
      cost: 100,
      latencyMs: 1000,
      activatedEdits: ['E1', 'E2'],
      benefitedEdits: ['E1'],
    },
    ablations: {
      E1: { verifiedSuccessDelta: 0.1, guardRegression: false, activated: true, benefited: true },
      E2: { verifiedSuccessDelta: -0.1, guardRegression: true, activated: true, benefited: false },
    },
  },
];

describe('post-GEPA edit ledger and rejected buffer', () => {
  test('derives accepted and rejected edit records from an eval report', () => {
    const c = candidate();
    const report = evaluateCandidateBundle(c, cases);
    const accepted = toEditLedgerRecords(c, report, 'accepted');
    const rejected = toRejectedEditRecords(c, report);

    assert.deepEqual(accepted.map((record) => record.editId), ['E1']);
    assert.deepEqual(rejected.map((record) => record.editId), ['E2']);
    assert.equal(accepted[0]!.harnessId, 'ielts-tutor');
    assert.equal(rejected[0]!.harnessDomain, 'education.language.ielts');
    assert.match(rejected[0]!.reasons.join('\n'), /ablation/i);
  });

  test('persists ledger and rejected records as sidecar JSONL and reloads rejected fingerprints', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vegito-ledger-'));
    const c = candidate();
    const report = evaluateCandidateBundle(c, cases);
    const accepted = toEditLedgerRecords(c, report, 'accepted');
    const rejected = toRejectedEditRecords(c, report);

    await appendEditLedgerRecords(root, accepted);
    await appendRejectedEditRecords(root, rejected);

    const ledgerText = await readFile(join(root, EDIT_LEDGER), 'utf8');
    const rejectedText = await readFile(join(root, REJECTED_EDITS), 'utf8');
    assert.match(ledgerText, /cand-ielts-ledger/);
    assert.match(rejectedText, /E2/);

    const fingerprints = await loadRejectedFingerprints(root);
    assert.equal(fingerprints.has(rejected[0]!.fingerprint), true);
  });
});

