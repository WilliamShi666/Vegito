import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateToProposal,
  defaultEvidenceContract,
  editFingerprint,
  validateCandidateBundle,
} from '../../../src/evolve/candidate.ts';
import type { CandidateBundle } from '../../../src/evolve/types.ts';

const validCandidate: CandidateBundle = {
  schema: 1,
  candidateId: 'cand-ielts-001',
  harnessId: 'ielts-tutor',
  harnessDomain: 'education.language.ielts',
  parentPackVersion: '1.0.0',
  proposer: { kind: 'human', version: 'fixture' },
  diagnosis: {
    failureLayer: 'skill',
    userGoal: 'improve IELTS writing feedback usefulness',
    evidenceIds: ['obs-1'],
    summary: 'feedback buries the actionable band-score advice',
  },
  atomicEdits: [
    {
      editId: 'E1',
      target: 'persona.md',
      operation: 'add',
      bounded: true,
      text: '\n## Learned constraints\n\n- Lead with the band score before hedging.\n',
      diagnosis: 'make feedback more direct',
      prediction: { metric: 'verified_success', deltaMin: 0.05 },
      risks: ['rubric_drift'],
      activationPath: ['prompt_surface'],
      rollback: { type: 'preimage_hash', value: 'abc123' },
    },
  ],
  requiredEvalSuites: ['selection', 'holdout', 'safety', 'activation'],
  notes: 'fixture',
};

describe('post-GEPA candidate bundle validation', () => {
  test('accepts a generated-harness candidate with atomic bounded text edits', () => {
    const result = validateCandidateBundle(validCandidate);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.harnessId, 'ielts-tutor');
    assert.deepEqual(result.value.harnessDomain, 'education.language.ielts');
  });

  test('rejects candidates missing generated harness identity', () => {
    const raw = { ...validCandidate, harnessId: '' };
    const result = validateCandidateBundle(raw);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /harnessId/i);
  });

  test('rejects source patch and system-owned targets in the MVP', () => {
    const sourcePatch = {
      ...validCandidate,
      atomicEdits: [{ ...validCandidate.atomicEdits[0]!, operation: 'source_patch', target: 'src/evolve/apply.ts' }],
    };
    const sourceResult = validateCandidateBundle(sourcePatch);
    assert.equal(sourceResult.ok, false);
    assert.match(sourceResult.ok ? '' : sourceResult.reason, /source.*MVP|unsupported operation/i);

    const systemTarget = {
      ...validCandidate,
      atomicEdits: [{ ...validCandidate.atomicEdits[0]!, target: '.evolve/provenance.jsonl' }],
    };
    const systemResult = validateCandidateBundle(systemTarget);
    assert.equal(systemResult.ok, false);
    assert.match(systemResult.ok ? '' : systemResult.reason, /system-owned/i);
  });

  test('rejects unknown proposer kinds and refuses direct durable-write authority', () => {
    const raw = { ...validCandidate, proposer: { kind: 'moss', version: 'future' } };
    const result = validateCandidateBundle(raw);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /proposer/i);
  });

  test('converts a single accepted bounded edit into the existing append-only Proposal shape', () => {
    const result = validateCandidateBundle(validCandidate);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const proposal = candidateToProposal(result.value, 'E1');
    assert.deepEqual(proposal, {
      kind: 'pack_edit',
      id: 'cand-ielts-001:E1',
      target: 'persona.md',
      text: '\n## Learned constraints\n\n- Lead with the band score before hedging.\n',
      provenance: ['obs-1'],
    });
  });

  test('edit fingerprint is stable and includes harness identity to prevent cross-harness promotion', () => {
    const result = validateCandidateBundle(validCandidate);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const edit = result.value.atomicEdits[0]!;

    const same = editFingerprint(result.value, edit);
    const changedHarness = editFingerprint({ ...result.value, harnessId: 'data-analysis-team' }, edit);
    assert.equal(editFingerprint(result.value, { ...edit }), same);
    assert.notEqual(changedHarness, same);
  });

  test('default evidence contract includes generated-harness fit and safety guard metrics', () => {
    const contract = defaultEvidenceContract('education.language.ielts');
    assert.ok(contract.primaryMetrics.includes('verified_success'));
    assert.ok(contract.domainMetrics.includes('user_goal_fit'));
    assert.ok(contract.guardMetrics.includes('permission_safety'));
    assert.ok(contract.activationMetrics.includes('artifact_loaded'));
  });
});

