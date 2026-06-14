import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { importGepaCandidate } from '../../../src/evolve/gepa.ts';
import { validateCandidateBundle } from '../../../src/evolve/candidate.ts';

describe('GEPA proposer import', () => {
  test('imports a Pareto-diverse GEPA candidate for a generated harness', () => {
    const imported = importGepaCandidate({
      candidate_id: 'gepa-cand-001',
      harness_id: 'data-analysis-team',
      harness_domain: 'analytics.data_science',
      parent_pack_version: '1.0.0',
      gepa_run_id: 'gepa-run-7',
      model: 'deepseek-v4-pro',
      pareto: {
        frontier_rank: 0,
        dominated: false,
        objectives: { verified_success: 0.82, cost_delta: 0.04 },
      },
      diagnosis: {
        failure_layer: 'skill',
        user_goal: 'improve dataframe cleaning workflow',
        evidence_ids: ['trace-1'],
        summary: 'agent skips null-profile before transformation',
      },
      edits: [
        {
          edit_id: 'E1',
          target: 'skills/data-cleaning/SKILL.md',
          operation: 'replace',
          text: '\n## Null profiling\n\n- Profile missing values before transformations.\n',
          prediction: { metric: 'verified_success', delta_min: 0.07 },
          risks: ['token_cost'],
          activation_path: ['skill_lookup'],
          rollback: { type: 'preimage_hash', value: 'skill-preimage' },
        },
      ],
    });

    assert.equal(imported.proposer.kind, 'gepa');
    assert.equal(imported.proposer.version, 'gepa-run-7');
    assert.equal(imported.proposer.model, 'deepseek-v4-pro');
    assert.deepEqual(imported.pareto, {
      frontierRank: 0,
      dominated: false,
      objectives: { verified_success: 0.82, cost_delta: 0.04 },
    });

    const validated = validateCandidateBundle(imported);
    assert.equal(validated.ok, true);
  });

  test('Pareto non-dominated status is metadata, not promotion authority', () => {
    const imported = importGepaCandidate({
      candidate_id: 'gepa-cand-unsafe',
      harness_id: 'ielts-tutor',
      harness_domain: 'education.language.ielts',
      parent_pack_version: '1.0.0',
      gepa_run_id: 'gepa-run-unsafe',
      pareto: { frontier_rank: 0, dominated: false, objectives: { verified_success: 0.9 } },
      diagnosis: {
        failure_layer: 'prompt',
        user_goal: 'speed up grading',
        evidence_ids: ['trace-2'],
        summary: 'unsafe candidate tries to rewrite manifest',
      },
      edits: [
        {
          edit_id: 'E1',
          target: 'pack.json',
          operation: 'replace',
          text: '{"version":"999.0.0"}',
          prediction: { metric: 'verified_success', delta_min: 0.5 },
          rollback: { type: 'preimage_hash', value: 'manifest-preimage' },
        },
      ],
    });

    const validated = validateCandidateBundle(imported);
    assert.equal(imported.pareto?.dominated, false);
    assert.equal(validated.ok, false);
    assert.match(validated.ok ? '' : validated.reason, /system-owned/i);
  });
});

