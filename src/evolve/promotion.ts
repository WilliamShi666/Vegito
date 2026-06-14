import { candidateToProposal } from './candidate.ts';
import type { CandidateBundle, CandidateEvalReport, Proposal } from './types.ts';

export interface PromotionPlan {
  readonly proposals: readonly Proposal[];
  readonly problems: readonly string[];
}

export function promotionPlanFromEval(candidate: CandidateBundle, report: CandidateEvalReport): PromotionPlan {
  if (report.decision.verdict === 'rejected') return { proposals: [], problems: [] };

  const accepted = candidate.atomicEdits.filter((edit) => report.decision.acceptedEditIds.includes(edit.editId));
  const unsupported = accepted.filter((edit) => edit.operation !== 'add');
  const problems = unsupported.map(
    (edit) => `edit ${edit.editId} uses ${edit.operation}; durable post-GEPA promotion currently supports add-only append edits`,
  );
  if (problems.length > 0) return { proposals: [], problems };

  return {
    proposals: accepted.map((edit) => candidateToProposal(candidate, edit.editId)),
    problems: [],
  };
}
