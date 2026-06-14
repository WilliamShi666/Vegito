// Forge IR (DESIGN §10/D14). A ForgeSpec is the *resolved* description of a pack
// before it becomes files: prompts are inline text (not paths yet), tiers are
// abstract, validators are source bodies. It is the single intermediate form that
// every path into forge converges on — interview, `--from <docs>` ingestion, and
// the offline archetype templates all produce a ForgeSpec, and `generate.ts` turns
// any ForgeSpec into a file map that passes `packs validate`. Keeping it pure (no
// IO, no provider) is what makes both the templates and the generator unit-testable.

/** An agent in the forged team. `tier` is an abstract name resolved via `tiers`. */
export interface SpecAgent {
  readonly name: string;
  readonly tier: string;
  readonly tools: readonly string[];
  /** Inline persona/instructions for this sub-agent (becomes ./agents/<name>.md). */
  readonly prompt: string;
}

/** A rubric pairs a soft prompt with a hard validator body (small-harness lesson). */
export interface SpecRubric {
  readonly name: string;
  /** Soft check: what the grading model is asked to assess. */
  readonly prompt: string;
  /**
   * Hard check: a Node script body. Receives the candidate text on argv[2] (or
   * stdin) and exits non-zero on failure. Becomes ./rubrics/<name>.validator.mjs.
   */
  readonly validator: string;
}

export interface SpecCommand {
  readonly name: string;
  readonly description: string;
  readonly template: string;
}

export interface SpecEvalCase {
  readonly name: string;
  readonly prompt: string;
  readonly requiredSignals: readonly string[];
}

export interface SpecMemory {
  /** Seed memory records, one fact per line (becomes ./memory/seeds.md). */
  readonly seeds?: readonly string[];
  /** Promotion policy prose (L1→L2→L3 criteria). */
  readonly promotion?: string;
}

export interface ForgeSpec {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  /** Top-level persona for the pack as a whole (becomes ./persona.md). */
  readonly persona: string;
  readonly agents: readonly SpecAgent[];
  readonly rubrics: readonly SpecRubric[];
  readonly commands?: readonly SpecCommand[];
  readonly evals?: readonly SpecEvalCase[];
  readonly memory?: SpecMemory;
  /** Onboarding flow prose (becomes ./onboarding.md). */
  readonly onboarding?: string;
  /** Abstract tier → resolution hint. No vendor names (A6). */
  readonly tiers: Readonly<Record<string, string>>;
  /** Tool grants for the pack. */
  readonly grants: readonly string[];
}

/** Parameters every archetype template accepts; templates fill domain specifics. */
export interface ArchetypeParams {
  /** The field/domain the pack serves, e.g. "IELTS writing", "Go services". */
  readonly domain: string;
  /** Optional override for the pack id (kebab-case); derived from domain if absent. */
  readonly name?: string;
  /** Optional override for the human description. */
  readonly description?: string;
}

/** A template is a pure function from params to a fully-resolved ForgeSpec. */
export type Archetype = (params: ArchetypeParams) => ForgeSpec;

const KEBAB = /[^a-z0-9]+/g;

/** Lower-kebab a free-text domain into a safe pack id. */
export function slug(text: string): string {
  const s = text.toLowerCase().replace(KEBAB, '-').replace(/^-+|-+$/g, '');
  return s === '' ? 'pack' : s;
}
