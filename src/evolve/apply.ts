import { readFile, writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import { join, dirname, sep } from 'node:path';

import { validatePack } from '../extend/pack-validate.ts';
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

export async function applyProposals(
  root: string,
  proposals: readonly Proposal[],
  gate: Gate,
  opts: ApplyOpts,
): Promise<ApplyResult> {
  const allowed: Proposal[] = [];
  const denied: string[] = [];
  for (const p of proposals) {
    const verdict = await gate(p);
    if (verdict === 'allow') allowed.push(p);
    else denied.push(p.id);
  }
  if (allowed.length === 0) return { applied: [], denied };

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

  return { applied: allowed.map((p) => p.id), denied };
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
