import { appendJsonl } from '../lib/jsonl.ts';
import { estimateTokens } from '../context/tokens.ts';
import type { LoadedPack } from '../extend/packs.ts';
import { artifactForProposal } from './artifacts.ts';
import { join } from 'node:path';
import type {
  ActivationEvidence,
  EvolutionDecision,
  EvolutionMetric,
  EvolutionRun,
  Proposal,
} from './types.ts';

export const EVOLUTION_RUNS = '.evolve/runs.jsonl';

export interface DecisionInput {
  readonly candidateId: string;
  readonly verdict: 'accepted' | 'rejected';
  readonly reasons: readonly string[];
}

export interface BuildEvolutionRunOpts {
  readonly baselineVersion: string;
  readonly datasetIds: readonly string[];
  readonly constraints: readonly string[];
  readonly decisions: readonly DecisionInput[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function contentForMetric(p: Proposal): string {
  return p.kind === 'pack_edit' ? p.text : p.fact;
}

function proposalTarget(p: Proposal): string {
  return p.kind === 'pack_edit' ? p.target : `memory/${p.to}.md`;
}

function metricFor(p: Proposal): readonly EvolutionMetric[] {
  return [
    { candidateId: p.id, name: 'token_delta', value: estimateTokens(contentForMetric(p)) },
    { candidateId: p.id, name: 'cost_usd', value: 0 },
    { candidateId: p.id, name: 'latency_ms', value: 0 },
    { candidateId: p.id, name: 'hard_validator_pass', value: 1 },
  ];
}

export function buildEvolutionRun(
  pack: LoadedPack,
  proposals: readonly Proposal[],
  opts: BuildEvolutionRunOpts,
): EvolutionRun {
  const decisionById = new Map(opts.decisions.map((d) => [d.candidateId, d]));
  const decisions: EvolutionDecision[] = [];
  const activationEvidence: ActivationEvidence[] = [];
  const provenance: Record<string, readonly string[]> = {};
  const metrics: EvolutionMetric[] = [];

  for (const proposal of proposals) {
    const artifact = artifactForProposal(pack, proposal);
    const decision = decisionById.get(proposal.id) ?? { candidateId: proposal.id, verdict: 'rejected' as const, reasons: ['not evaluated'] };
    decisions.push({
      candidateId: proposal.id,
      artifact: artifact.kind,
      verdict: decision.verdict,
      reasons: [...decision.reasons],
    });
    provenance[proposal.id] = [...proposal.provenance];
    metrics.push(...metricFor(proposal));
    if (decision.verdict === 'accepted') {
      activationEvidence.push({
        candidateId: proposal.id,
        artifact: artifact.kind,
        surface: artifact.activationSurface,
        target: proposalTarget(proposal),
      });
    }
  }

  return {
    schema: 1,
    id: `evo-${Date.now().toString(36)}`,
    created: nowIso(),
    baselineVersion: opts.baselineVersion,
    candidateIds: proposals.map((p) => p.id),
    datasetIds: [...opts.datasetIds],
    metrics,
    constraints: [...opts.constraints],
    provenance,
    decisions,
    activationEvidence,
  };
}

export async function appendEvolutionRun(root: string, run: EvolutionRun): Promise<void> {
  await appendJsonl(join(root, EVOLUTION_RUNS), run);
}
