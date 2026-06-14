// P11.1 pack validation (DESIGN §10): the checks behind `vegito forge` and
// `packs validate` that go beyond path safety. Two are small-harness lessons
// distilled from the domain-pack study (vegito-notes/explorations):
//   1. Rubric pairing — a rubric without both a soft prompt and a hard
//      validator is half a check; the soft/hard pair is the whole point (§5.2).
//   2. Constraint budget — a prompt with more than five "don't/never/avoid"
//      lines reliably degrades; the model loses the prohibitions in the noise.
// Semantic checks are pure (manifest-only); content checks read the referenced
// files. Neither throws — both return a problem list so the CLI can print all
// failures at once rather than one-at-a-time.

import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { loadPack, type PackManifest } from './packs.ts';

export const MAX_NEGATIVE_CONSTRAINTS = 5;

// A negative constraint is an imperative prohibition. We match line-leading
// markers after optional list bullets, case-insensitively: "don't", "do not",
// "never", "avoid", "no " (as in "No fabrication."). Prose that merely contains
// the word "never" mid-sentence is not counted — the marker must lead the line.
const NEGATIVE_MARKERS = /^\s*(?:[-*]\s*)?(?:don'?t\b|do not\b|never\b|avoid\b|no\s)/i;

export function countNegativeConstraints(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    if (NEGATIVE_MARKERS.test(line)) n += 1;
  }
  return n;
}

// Pure manifest-level checks. Returns [] when clean.
export function validateManifestSemantics(manifest: PackManifest): string[] {
  const problems: string[] = [];

  const agentNames = new Set<string>();
  for (const a of manifest.agents) {
    if (agentNames.has(a.name)) problems.push(`duplicate agent name: ${a.name}`);
    agentNames.add(a.name);
    const tierRef = a.model.startsWith('tier:') ? a.model.slice('tier:'.length) : undefined;
    if (tierRef !== undefined && !(tierRef in manifest.modelTiers)) {
      problems.push(`agent "${a.name}" references undefined tier "${tierRef}"`);
    }
  }

  for (const r of manifest.rubrics) {
    if (r.prompt === '') problems.push(`rubric "${r.name}" is missing a prompt`);
    if (r.validator === '') problems.push(`rubric "${r.name}" is missing a validator (soft+hard pairing required)`);
  }

  return problems;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

function rel(p: string): string {
  return p.replace(/^\.\//, '').split('/').join(sep);
}

// Full validation: parse + path-safety (via loadPack) + semantics + content.
// The content pass reads every declared file, confirms it exists, and lints
// agent/persona prompts against the constraint budget.
export async function validatePack(root: string): Promise<ValidationResult> {
  const problems: string[] = [];

  let manifest: PackManifest;
  try {
    const loaded = await loadPack(root);
    manifest = loaded.manifest;
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)] };
  }

  problems.push(...validateManifestSemantics(manifest));

  // File-typed declarations must exist; directory containers (skills, commands,
  // hooks, memory-seeds) are validated by their loaders, not here. We check the
  // concrete files a pack promises: persona, onboarding, agent prompts, and
  // each rubric's prompt + validator.
  const filePaths: string[] = [];
  if (manifest.persona !== undefined) filePaths.push(manifest.persona);
  if (manifest.onboarding !== undefined) filePaths.push(manifest.onboarding);
  if (manifest.evals !== undefined) filePaths.push(manifest.evals);
  for (const a of manifest.agents) filePaths.push(a.prompt);
  for (const r of manifest.rubrics) {
    if (r.prompt !== '') filePaths.push(r.prompt);
    if (r.validator !== '') filePaths.push(r.validator);
  }
  for (const p of filePaths) {
    try {
      await readFile(join(root, rel(p)), 'utf8');
    } catch {
      problems.push(`declared file does not exist: ${p}`);
    }
  }

  // Constraint budget on prompt-bearing files (persona + agent prompts).
  const promptPaths = [manifest.persona, ...manifest.agents.map((a) => a.prompt)].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  );
  for (const p of promptPaths) {
    let text: string;
    try {
      text = await readFile(join(root, rel(p)), 'utf8');
    } catch {
      continue; // existence already reported above
    }
    const n = countNegativeConstraints(text);
    if (n > MAX_NEGATIVE_CONSTRAINTS) {
      problems.push(
        `prompt ${p} has ${n} negative constraints (max ${MAX_NEGATIVE_CONSTRAINTS}); over-constrained prompts degrade`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}
