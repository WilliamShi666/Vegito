import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path';

import type { LoadedPack } from '../extend/packs.ts';
import type { ArtifactKind, Proposal } from './types.ts';

export interface ArtifactAdapter {
  readonly kind: ArtifactKind;
  readonly activationSurface: 'system_prompt' | 'rubric_prompt' | 'hard_validator' | 'skill_registry' | 'team_config' | 'memory_file';
  readonly allowsAppend: boolean;
}

export interface ProposalTargetOk {
  readonly ok: true;
  readonly rel: string;
  readonly artifact: ArtifactAdapter;
}

export interface ProposalTargetErr {
  readonly ok: false;
  readonly reason: string;
}

export type ProposalTargetValidation = ProposalTargetOk | ProposalTargetErr;

const ADAPTERS: Readonly<Record<ArtifactKind, ArtifactAdapter>> = Object.freeze({
  prompt_persona: { kind: 'prompt_persona', activationSurface: 'system_prompt', allowsAppend: true },
  rubric: { kind: 'rubric', activationSurface: 'rubric_prompt', allowsAppend: true },
  validator: { kind: 'validator', activationSurface: 'hard_validator', allowsAppend: false },
  skill: { kind: 'skill', activationSurface: 'skill_registry', allowsAppend: true },
  team_config: { kind: 'team_config', activationSurface: 'team_config', allowsAppend: true },
  memory_policy: { kind: 'memory_policy', activationSurface: 'memory_file', allowsAppend: true },
  source_patch: { kind: 'source_patch', activationSurface: 'team_config', allowsAppend: false },
});

function cleanRel(raw: string): string | undefined {
  const unix = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (unix === '' || unix === '.') return undefined;
  if (isAbsolute(raw) || posix.isAbsolute(unix)) return undefined;
  const norm = posix.normalize(unix);
  if (norm === '.' || norm.startsWith('../') || norm === '..') return undefined;
  return norm;
}

function manifestRel(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : cleanRel(raw);
}

function packTargets(pack: LoadedPack): {
  readonly persona: ReadonlySet<string>;
  readonly rubrics: ReadonlySet<string>;
  readonly validators: ReadonlySet<string>;
  readonly skillsRoot?: string;
  readonly onboarding?: string;
} {
  const persona = new Set<string>();
  const rubricPrompts = new Set<string>();
  const validators = new Set<string>();
  const p = manifestRel(pack.manifest.persona);
  if (p !== undefined) persona.add(p);
  for (const agent of pack.manifest.agents) {
    const rel = manifestRel(agent.prompt);
    if (rel !== undefined) persona.add(rel);
  }
  for (const rubric of pack.manifest.rubrics) {
    const prompt = manifestRel(rubric.prompt);
    if (prompt !== undefined) rubricPrompts.add(prompt);
    const validator = manifestRel(rubric.validator);
    if (validator !== undefined) validators.add(validator);
  }
  const result: {
    persona: ReadonlySet<string>;
    rubrics: ReadonlySet<string>;
    validators: ReadonlySet<string>;
    skillsRoot?: string;
    onboarding?: string;
  } = {
    persona,
    rubrics: rubricPrompts,
    validators,
  };
  const skillsRoot = manifestRel(pack.manifest.skills);
  if (skillsRoot !== undefined) result.skillsRoot = skillsRoot;
  const onboarding = manifestRel(pack.manifest.onboarding);
  if (onboarding !== undefined) result.onboarding = onboarding;
  return result;
}

function isSkillTarget(skillsRoot: string | undefined, rel: string): boolean {
  if (skillsRoot === undefined) return false;
  return rel.startsWith(`${skillsRoot}/`) && basename(rel) === 'SKILL.md';
}

function isSystemOwned(rel: string): boolean {
  return rel === 'pack.json' || rel === '.evolve' || rel.startsWith('.evolve/');
}

async function pathInsidePack(pack: LoadedPack, rel: string): Promise<boolean> {
  const rootReal = await realpath(pack.root);
  const abs = join(rootReal, rel.split('/').join(sep));
  let cursor = abs;
  for (;;) {
    try {
      const anchor = await realpath(cursor);
      const back = relative(rootReal, anchor);
      return back === '' || (!back.startsWith(`..${sep}`) && back !== '..' && !isAbsolute(back));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(cursor);
      if (parent === cursor) return false;
      cursor = parent;
    }
  }
}

export function artifactForProposal(pack: LoadedPack, proposal: Proposal): ArtifactAdapter {
  if (proposal.kind === 'memory_promote') return ADAPTERS.memory_policy;
  const rel = cleanRel(proposal.target);
  if (rel === undefined) return ADAPTERS.source_patch;
  const targets = packTargets(pack);
  if (targets.persona.has(rel)) return ADAPTERS.prompt_persona;
  if (targets.rubrics.has(rel)) return ADAPTERS.rubric;
  if (targets.validators.has(rel)) return ADAPTERS.validator;
  if (isSkillTarget(targets.skillsRoot, rel)) return ADAPTERS.skill;
  if (targets.onboarding === rel) return ADAPTERS.team_config;
  if (rel === 'pack.json') return ADAPTERS.team_config;
  return ADAPTERS.source_patch;
}

export async function validateProposalTarget(pack: LoadedPack, proposal: Proposal): Promise<ProposalTargetValidation> {
  const rel = proposal.kind === 'pack_edit' ? cleanRel(proposal.target) : `memory/${proposal.to}.md`;
  if (rel === undefined) return { ok: false, reason: `unsafe proposal target: ${proposal.kind === 'pack_edit' ? proposal.target : ''}` };
  if (isSystemOwned(rel)) return { ok: false, reason: `system-owned target cannot be edited by proposal: ${rel}` };
  if (!(await pathInsidePack(pack, rel))) return { ok: false, reason: `unsafe proposal target escapes pack root: ${rel}` };

  const artifact = artifactForProposal(pack, proposal);
  if (artifact.kind === 'source_patch') return { ok: false, reason: `proposal target is not declared by pack manifest: ${rel}` };
  if (!artifact.allowsAppend) return { ok: false, reason: `${artifact.kind} edits require a typed evaluator and are not append-only` };
  return { ok: true, rel, artifact };
}
