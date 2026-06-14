import type { CandidateBundle, AtomicEdit } from './types.ts';

interface RawGepaEdit {
  readonly edit_id: string;
  readonly target: string;
  readonly operation: string;
  readonly text: string;
  readonly prediction: {
    readonly metric: string;
    readonly delta_min: number;
  };
  readonly risks?: readonly string[];
  readonly activation_path?: readonly string[];
  readonly rollback: {
    readonly type: 'preimage_hash' | 'inverse_patch';
    readonly value: string;
  };
}

interface RawGepaCandidate {
  readonly candidate_id: string;
  readonly harness_id: string;
  readonly harness_domain: string;
  readonly parent_pack_version: string;
  readonly gepa_run_id: string;
  readonly model?: string;
  readonly pareto?: {
    readonly frontier_rank: number;
    readonly dominated: boolean;
    readonly objectives: Readonly<Record<string, number>>;
  };
  readonly diagnosis: {
    readonly failure_layer: string;
    readonly user_goal?: string;
    readonly evidence_ids: readonly string[];
    readonly summary: string;
  };
  readonly edits: readonly RawGepaEdit[];
}

function normalizeEdit(edit: RawGepaEdit): AtomicEdit {
  return {
    editId: edit.edit_id,
    target: edit.target,
    operation: edit.operation as AtomicEdit['operation'],
    bounded: false,
    text: edit.text,
    diagnosis: `GEPA edit ${edit.edit_id}`,
    prediction: {
      metric: edit.prediction.metric,
      deltaMin: edit.prediction.delta_min,
    },
    risks: edit.risks ?? [],
    activationPath: edit.activation_path ?? [],
    rollback: edit.rollback,
  };
}

export function importGepaCandidate(raw: RawGepaCandidate): CandidateBundle {
  return {
    schema: 1,
    candidateId: raw.candidate_id,
    harnessId: raw.harness_id,
    harnessDomain: raw.harness_domain,
    parentPackVersion: raw.parent_pack_version,
    proposer: {
      kind: 'gepa',
      version: raw.gepa_run_id,
      ...(raw.model === undefined ? {} : { model: raw.model }),
    },
    diagnosis: {
      failureLayer: raw.diagnosis.failure_layer as CandidateBundle['diagnosis']['failureLayer'],
      ...(raw.diagnosis.user_goal === undefined ? {} : { userGoal: raw.diagnosis.user_goal }),
      evidenceIds: raw.diagnosis.evidence_ids,
      summary: raw.diagnosis.summary,
    },
    atomicEdits: raw.edits.map(normalizeEdit),
    requiredEvalSuites: ['selection', 'holdout', 'safety', 'activation'],
    ...(raw.pareto === undefined
      ? {}
      : {
          pareto: {
            frontierRank: raw.pareto.frontier_rank,
            dominated: raw.pareto.dominated,
            objectives: raw.pareto.objectives,
          },
        }),
  };
}

