// Forge interview (DESIGN §10/D14). Three ways to reach a ForgePlan — explicit
// flags, an interactive elicitation, and `--from <docs>` ingestion — all converge
// on the same { archetype, params } pair that `generate.ts` consumes. The pure
// pieces (planFromFlags, inferPlan) are unit-testable without a TTY; the
// interactive `interview` is a thin shell over an injected ask port so the
// scripted path drives it offline. No provider call lives here: archetype
// templates already produce a complete, valid pack — the model only *enriches*
// (a separate, optional step), so the offline path is the whole flow minus polish.

import { ARCHETYPE_IDS, getArchetype } from './templates/index.ts';
import type { ArchetypeParams, ForgeSpec } from './spec.ts';

export interface ForgePlan {
  readonly archetype: string;
  readonly params: ArchetypeParams;
}

export type AskPort = (question: string) => Promise<string>;

const DEFAULT_ARCHETYPE = 'tutor-team';

/** Build a plan straight from flags. Returns an error string if archetype is unknown. */
export function planFromFlags(opts: {
  archetype?: string;
  domain?: string;
  name?: string;
}): ForgePlan | { error: string } {
  const archetype = opts.archetype ?? DEFAULT_ARCHETYPE;
  if (!ARCHETYPE_IDS.includes(archetype)) {
    return { error: `unknown archetype "${archetype}" (known: ${ARCHETYPE_IDS.join(', ')})` };
  }
  const domain = (opts.domain ?? '').trim();
  if (domain === '') return { error: 'forge needs a --domain (or run without --offline to be asked)' };
  const params: ArchetypeParams = {
    domain,
    ...(opts.name !== undefined ? { name: opts.name } : {}),
  };
  return { archetype, params };
}

// Keyword → archetype heuristics for `--from <docs>`. First match wins; order
// matters (review's "audit"/"security" beat generic verbs). Falls back to tutor.
const INGEST_RULES: readonly { readonly re: RegExp; readonly archetype: string }[] = [
  { re: /\b(review|audit|security|lint|critique|pull request|code\s?review)\b/i, archetype: 'review-team' },
  { re: /\b(write|writing|content|blog|copy|article|draft|editor|newsletter)\b/i, archetype: 'content-studio' },
  { re: /\b(tutor|learn|teach|exam|study|practice|coach|drill|lesson|course)\b/i, archetype: 'tutor-team' },
];

/**
 * Infer a plan from a documents corpus: pick the archetype by keyword vote and
 * take the domain from the first heading or non-empty line. Pure over the text.
 */
export function inferPlan(docs: string, nameHint?: string): ForgePlan {
  const archetype = pickArchetype(docs);
  const domain = firstHeadingOrLine(docs) || 'the documented domain';
  const params: ArchetypeParams = {
    domain,
    ...(nameHint !== undefined ? { name: nameHint } : {}),
  };
  return { archetype, params };
}

function pickArchetype(docs: string): string {
  // Vote: count keyword hits per rule, highest wins; ties break by rule order.
  let best = DEFAULT_ARCHETYPE;
  let bestScore = 0;
  for (const rule of INGEST_RULES) {
    const matches = docs.match(new RegExp(rule.re.source, 'gi'));
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = rule.archetype;
    }
  }
  return best;
}

function firstHeadingOrLine(docs: string): string {
  for (const raw of docs.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line !== '') return line.length > 80 ? line.slice(0, 80).trim() : line;
  }
  return '';
}

/**
 * Interactive elicitation over an ask port. Asks for archetype (offering the
 * known ids) and domain, with an optional name. Re-asks archetype once on an
 * unknown answer, then falls back to the default rather than looping forever.
 */
export async function interview(ask: AskPort): Promise<ForgePlan> {
  const archetypeAnswer = (await ask(`Which archetype? (${ARCHETYPE_IDS.join(' / ')}) [${DEFAULT_ARCHETYPE}]`)).trim();
  let archetype = archetypeAnswer === '' ? DEFAULT_ARCHETYPE : archetypeAnswer;
  if (!ARCHETYPE_IDS.includes(archetype)) {
    const retry = (await ask(`"${archetype}" is not known. Pick one of ${ARCHETYPE_IDS.join(', ')} [${DEFAULT_ARCHETYPE}]`)).trim();
    archetype = ARCHETYPE_IDS.includes(retry) ? retry : DEFAULT_ARCHETYPE;
  }
  const domainAnswer = (await ask('What domain should this pack serve? (e.g. "IELTS writing")')).trim();
  const domain = domainAnswer === '' ? 'a general domain' : domainAnswer;
  const nameAnswer = (await ask('Pack id? (blank to derive from the domain)')).trim();

  const params: ArchetypeParams = {
    domain,
    ...(nameAnswer !== '' ? { name: nameAnswer } : {}),
  };
  return { archetype, params };
}

/** Resolve a plan to a ForgeSpec via its archetype template. */
export function planToSpec(plan: ForgePlan): ForgeSpec {
  return getArchetype(plan.archetype)(plan.params);
}
