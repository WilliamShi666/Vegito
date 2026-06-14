import { readFile, writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';

import { validatePack } from '../extend/pack-validate.ts';
import { loadPack, type LoadedPack } from '../extend/packs.ts';
import { validateProposalTarget } from './artifacts.ts';
import { appendEvolutionRun, buildEvolutionRun, EVOLUTION_RUNS, type DecisionInput } from './evaluation.ts';
import type { Proposal, ProvenanceRecord } from './types.ts';

// apply (DESIGN §8): proposals → versioned, gated, revertible pack mutations.
// Evolution is "not a backdoor" — every mutation passes the SAME permission
// gate as any other write, here injected as `Gate`. Applied batches snapshot
// the exact prior bytes of every file they touch into .evolve/provenance.jsonl,
// so `revert` is a pure byte restore. A batch is atomic: if the mutated pack
// fails validation, every file is rolled back and the version is untouched.

export type GateVerdict = 'allow' | 'deny';
export type Gate = (proposal: Proposal) => Promise<GateVerdict>;

export interface ApplyOpts {
  readonly sids: readonly string[];
  readonly datasets?: readonly string[];
}

export interface ApplyResult {
  readonly applied: readonly string[];
  readonly denied: readonly string[];
  readonly problems?: readonly string[];
}

const PROVENANCE = join('.evolve', 'provenance.jsonl');

export function bumpVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (m === null) return `${version}+1`;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

function abs(root: string, rel: string): string {
  return join(root, rel.split('/').join(sep));
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

// Restore a snapshot map (rel → prior bytes, or null = file did not exist).
async function restore(root: string, snapshot: Readonly<Record<string, string | null>>): Promise<void> {
  for (const [rel, prior] of Object.entries(snapshot)) {
    const path = abs(root, rel);
    if (prior === null) {
      await rm(path, { force: true });
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, prior, 'utf8');
    }
  }
}

function memoryLine(fact: string, from: string, to: string, provenance: readonly string[]): string {
  const prov = provenance.length > 0 ? `; from ${provenance.join(', ')}` : '';
  return `- ${fact} (promoted ${from}→${to}${prov})\n`;
}

function systemProposal(id: string, target: string): Proposal {
  return { kind: 'pack_edit', id, target, text: '', provenance: [] };
}

async function requireSystemWrite(gate: Gate, target: string): Promise<string | undefined> {
  const verdict = await gate(systemProposal(`system:${target}`, target));
  return verdict === 'allow' ? undefined : `system write denied: ${target}`;
}

function datasetIds(opts: ApplyOpts): readonly string[] {
  return [...new Set([...opts.sids, ...(opts.datasets ?? [])])];
}

async function loadBaseline(root: string): Promise<{ pack: LoadedPack; version: string } | { problems: readonly string[] }> {
  try {
    const pack = await loadPack(root);
    return { pack, version: pack.manifest.version };
  } catch (err) {
    return { problems: [err instanceof Error ? err.message : String(err)] };
  }
}

async function maybeRecordRun(
  root: string,
  pack: LoadedPack,
  proposals: readonly Proposal[],
  decisions: readonly DecisionInput[],
  opts: ApplyOpts,
  baselineVersion: string,
): Promise<void> {
  if (proposals.length === 0 || decisions.length === 0) return;
  const run = buildEvolutionRun(pack, proposals, {
    baselineVersion,
    datasetIds: datasetIds(opts),
    constraints: [
      'target containment',
      'typed artifact adapters',
      'hard pack validation',
      'review-only by default',
      'activation evidence required',
    ],
    decisions,
  });
  await appendEvolutionRun(root, run);
}

export async function applyProposals(
  root: string,
  proposals: readonly Proposal[],
  gate: Gate,
  opts: ApplyOpts,
): Promise<ApplyResult> {
  const baseline = await loadBaseline(root);
  if ('problems' in baseline) return { applied: [], denied: [], problems: baseline.problems };
  const { pack, version: baselineVersion } = baseline;

  const allowed: Proposal[] = [];
  const denied: string[] = [];
  const problems: string[] = [];
  const decisions: DecisionInput[] = [];

  for (const p of proposals) {
    const target = await validateProposalTarget(pack, p);
    if (!target.ok) {
      problems.push(`${p.id}: ${target.reason}`);
      decisions.push({ candidateId: p.id, verdict: 'rejected', reasons: [target.reason] });
      continue;
    }
    const verdict = await gate(p);
    if (verdict === 'allow') {
      allowed.push(p);
      decisions.push({ candidateId: p.id, verdict: 'accepted', reasons: ['passed target validation and permission gate'] });
    } else {
      denied.push(p.id);
      decisions.push({ candidateId: p.id, verdict: 'rejected', reasons: ['permission gate denied proposal write'] });
    }
  }

  const runGateProblem = await requireSystemWrite(gate, EVOLUTION_RUNS);
  if (allowed.length === 0) {
    if (runGateProblem === undefined) {
      await maybeRecordRun(root, pack, proposals, decisions, opts, baselineVersion);
    }
    return problems.length > 0 ? { applied: [], denied, problems } : { applied: [], denied };
  }

  const systemProblems = [
    runGateProblem,
    await requireSystemWrite(gate, 'pack.json'),
    await requireSystemWrite(gate, PROVENANCE),
  ].filter((p): p is string => p !== undefined);
  if (systemProblems.length > 0) return { applied: [], denied, problems: systemProblems };

  // Snapshot every file the batch will touch, plus pack.json (version bump),
  // capturing pre-mutation bytes exactly once (the earliest read wins).
  const snapshot: Record<string, string | null> = {};
  const touch = async (rel: string): Promise<void> => {
    if (rel in snapshot) return;
    snapshot[rel] = await readMaybe(abs(root, rel));
  };
  await touch('pack.json');
  for (const p of allowed) {
    await touch(p.kind === 'pack_edit' ? p.target : `memory/${p.to}.md`);
  }

  // Apply mutations (append-only).
  for (const p of allowed) {
    if (p.kind === 'pack_edit') {
      const path = abs(root, p.target);
      const current = (await readMaybe(path)) ?? '';
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, current + p.text, 'utf8');
    } else {
      const rel = `memory/${p.to}.md`;
      const path = abs(root, rel);
      const current = (await readMaybe(path)) ?? '';
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, current + memoryLine(p.fact, p.from, p.to, p.provenance), 'utf8');
    }
  }

  // Version bump in pack.json (same 2-space + trailing-newline formatting the
  // forge emits, so a re-forge diff stays clean).
  const manifestText = await readFile(abs(root, 'pack.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const prevVersion = typeof manifest['version'] === 'string' ? (manifest['version'] as string) : '0.0.0';
  const version = bumpVersion(prevVersion);
  manifest['version'] = version;
  await writeFile(abs(root, 'pack.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Validate the mutated pack. On any problem, roll the whole batch back.
  const validation = await validatePack(root);
  if (!validation.ok) {
    await restore(root, snapshot);
    const failedDecisions = allowed.map((p): DecisionInput => ({
      candidateId: p.id,
      verdict: 'rejected',
      reasons: validation.problems,
    }));
    await maybeRecordRun(root, pack, allowed, failedDecisions, opts, baselineVersion);
    return { applied: [], denied, problems: validation.problems };
  }

  // Persist provenance for revert.
  const observations: string[] = [];
  for (const p of allowed) {
    for (const o of p.provenance) if (!observations.includes(o)) observations.push(o);
  }
  const record: ProvenanceRecord = {
    schema: 1,
    version,
    prevVersion,
    proposals: allowed.map((p) => p.id),
    observations,
    sids: [...opts.sids],
    snapshot,
  };
  await mkdir(abs(root, '.evolve'), { recursive: true });
  const provPath = abs(root, PROVENANCE);
  const existing = (await readMaybe(provPath)) ?? '';
  await writeFile(provPath, existing + `${JSON.stringify(record)}\n`, 'utf8');
  await maybeRecordRun(root, pack, proposals, decisions, opts, baselineVersion);

  return problems.length > 0 ? { applied: allowed.map((p) => p.id), denied, problems } : { applied: allowed.map((p) => p.id), denied };
}

// Revert the most recent applied batch: restore its snapshot byte-identically
// and pop the record. No-op if there is nothing to revert.
export async function revert(root: string): Promise<ProvenanceRecord | undefined> {
  const provPath = abs(root, PROVENANCE);
  const text = await readMaybe(provPath);
  if (text === null || text.trim() === '') return undefined;
  const lines = text.trim().split('\n');
  const last = lines.pop()!;
  const record = JSON.parse(last) as ProvenanceRecord;
  await restore(root, record.snapshot);
  if (lines.length > 0) await writeFile(provPath, `${lines.join('\n')}\n`, 'utf8');
  else await unlink(provPath);
  return record;
}
