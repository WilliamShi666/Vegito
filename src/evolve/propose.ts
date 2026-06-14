import { slug } from '../forge/spec.ts';
import { countNegativeConstraints, MAX_NEGATIVE_CONSTRAINTS } from '../extend/pack-validate.ts';
import { nextLevel, type Observation, type Proposal } from './types.ts';

// propose (DESIGN §8): pure observations → Proposals. No IO, no model. Each
// observation kind routes to a concrete, append-only mutation:
//   friction        → one persona.md edit (all constraints, budget-clamped)
//   rubric_drift     → one edit per rubric prompt file (grouped by rubric)
//   missing_skill    → one onboarding.md edit (all skills)
//   memory_candidate → one promotion up the ladder (l3 is terminal, dropped)
// Proposals are append-only by construction: evolution adds guidance, never
// rewrites it, so a revert is a pure byte restore (apply.ts).

export interface ProposeOpts {
  // Negative constraints already present in the persona, so the budget is
  // enforced against the post-merge total rather than just the new lines.
  readonly personaNegatives?: number;
  readonly knownRubrics?: readonly string[];
}

const NEGATIVE_MARKER = /^\s*(?:[-*]\s*)?(?:don'?t\b|do not\b|never\b|avoid\b|no\s)/i;

function isNegative(line: string): boolean {
  return NEGATIVE_MARKER.test(line);
}

function bullet(text: string): string {
  return `- ${text}`;
}

// Append a block under a heading, as a leading-blank-line section so repeated
// applies stay readable and diffable.
function section(heading: string, lines: readonly string[]): string {
  return `\n## ${heading}\n\n${lines.join('\n')}\n`;
}

export function propose(observations: readonly Observation[], opts: ProposeOpts = {}): readonly Proposal[] {
  const proposals: Proposal[] = [];
  let counter = 0;
  const nextId = (): string => `prop#${counter++}`;

  const friction = observations.filter((o) => o.kind === 'friction');
  const drift = observations.filter((o) => o.kind === 'rubric_drift');
  const skills = observations.filter((o) => o.kind === 'missing_skill');
  const memory = observations.filter((o) => o.kind === 'memory_candidate');

  // --- friction → persona constraints (budget-clamped) ---
  if (friction.length > 0) {
    let negativesUsed = opts.personaNegatives ?? 0;
    const accepted: string[] = [];
    const provenance: string[] = [];
    for (const o of friction) {
      if (o.kind !== 'friction') continue;
      const neg = isNegative(o.constraint);
      // Negative constraints over-constrain a prompt; clamp them to the cap.
      // Positive guidance is always admitted.
      if (neg && negativesUsed >= MAX_NEGATIVE_CONSTRAINTS) continue;
      if (neg) negativesUsed += 1;
      accepted.push(bullet(o.constraint));
      provenance.push(o.id);
    }
    if (accepted.length > 0) {
      proposals.push({
        kind: 'pack_edit',
        id: nextId(),
        target: 'persona.md',
        text: section('Learned constraints', accepted),
        provenance,
      });
    }
  }

  // --- rubric_drift → per-rubric prompt edits ---
  const knownRubrics =
    opts.knownRubrics === undefined ? undefined : new Set(opts.knownRubrics.map((name) => slug(name)));
  const byRubric = new Map<string, { lines: string[]; prov: string[] }>();
  const rubricOrder: string[] = [];
  for (const o of drift) {
    if (o.kind !== 'rubric_drift') continue;
    if (knownRubrics !== undefined && !knownRubrics.has(slug(o.rubric))) continue;
    const target = `rubrics/${slug(o.rubric)}.prompt.md`;
    let group = byRubric.get(target);
    if (group === undefined) {
      group = { lines: [], prov: [] };
      byRubric.set(target, group);
      rubricOrder.push(target);
    }
    group.lines.push(bullet(o.guidance));
    group.prov.push(o.id);
  }
  for (const target of rubricOrder) {
    const group = byRubric.get(target)!;
    proposals.push({
      kind: 'pack_edit',
      id: nextId(),
      target,
      text: section('Refinements', group.lines),
      provenance: group.prov,
    });
  }

  // --- missing_skill → one onboarding edit ---
  if (skills.length > 0) {
    const lines: string[] = [];
    const provenance: string[] = [];
    for (const o of skills) {
      if (o.kind !== 'missing_skill') continue;
      lines.push(bullet(`Consider adding the \`${o.skill}\` skill.`));
      provenance.push(o.id);
    }
    proposals.push({
      kind: 'pack_edit',
      id: nextId(),
      target: 'onboarding.md',
      text: section('Suggested skills', lines),
      provenance,
    });
  }

  // --- memory_candidate → promotion up one level ---
  for (const o of memory) {
    if (o.kind !== 'memory_candidate') continue;
    const to = nextLevel(o.level);
    if (to === undefined) continue; // l3 is the top of the ladder
    proposals.push({
      kind: 'memory_promote',
      id: nextId(),
      fact: o.fact,
      from: o.level,
      to,
      provenance: [o.id],
    });
  }

  return proposals;
}
