import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { applyProposals, revert, bumpVersion, type Gate } from '../../../src/evolve/apply.ts';
import { generatePack } from '../../../src/forge/generate.ts';
import { getArchetype } from '../../../src/forge/templates/index.ts';
import type { Proposal } from '../../../src/evolve/types.ts';

const allow: Gate = async () => 'allow';
const deny: Gate = async () => 'deny';

async function makePack(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evolve-apply-'));
  const spec = getArchetype('tutor-team')({ domain: 'IELTS writing' });
  await generatePack(root, spec);
  return root;
}

// Recursively snapshot every file under a dir as rel→bytes, skipping .evolve
// sidecar bookkeeping (which is allowed to differ across apply/revert).
async function snapshotDir(root: string, sub = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const dir = join(root, sub);
  for (const name of (await readdir(dir)).sort()) {
    if (sub === '' && name === '.evolve') continue;
    const rel = sub === '' ? name : `${sub}/${name}`;
    const st = await stat(join(root, rel));
    if (st.isDirectory()) {
      for (const [k, v] of await snapshotDir(root, rel)) out.set(k, v);
    } else {
      out.set(rel, await readFile(join(root, rel), 'utf8'));
    }
  }
  return out;
}

test('bumpVersion increments the semver patch; non-semver falls back', () => {
  assert.equal(bumpVersion('1.0.0'), '1.0.1');
  assert.equal(bumpVersion('2.5.9'), '2.5.10');
  assert.equal(bumpVersion('0.0.0'), '0.0.1');
  assert.equal(bumpVersion('weird'), 'weird+1');
});

test('a gated-allow pack_edit appends to the file and bumps the version', async () => {
  const root = await makePack();
  const before = await readFile(join(root, 'persona.md'), 'utf8');
  const proposals: readonly Proposal[] = [
    {
      kind: 'pack_edit',
      id: 'prop#0',
      target: 'persona.md',
      text: '\n## Learned constraints\n\n- Lead with the band score.\n',
      provenance: ['s#0'],
    },
  ];
  const res = await applyProposals(root, proposals, allow, { sids: ['s'] });
  assert.deepEqual([...res.applied], ['prop#0']);
  assert.equal(res.denied.length, 0);
  const after = await readFile(join(root, 'persona.md'), 'utf8');
  assert.ok(after.startsWith(before));
  assert.match(after, /Lead with the band score\./);
  const manifest = JSON.parse(await readFile(join(root, 'pack.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.1');
});

test('a gated-deny proposal is skipped; the pack is untouched and version stays', async () => {
  const root = await makePack();
  const snap = await snapshotDir(root);
  const proposals: readonly Proposal[] = [
    { kind: 'pack_edit', id: 'p', target: 'persona.md', text: '\nX\n', provenance: ['s#0'] },
  ];
  const res = await applyProposals(root, proposals, deny, { sids: ['s'] });
  assert.deepEqual([...res.denied], ['p']);
  assert.equal(res.applied.length, 0);
  assert.deepEqual(await snapshotDir(root), snap);
});

test('unsafe proposal targets are rejected inside applyProposals before any write', async () => {
  const root = await makePack();
  const outsideName = `${basename(root)}-outside.txt`;
  const outside = join(root, '..', outsideName);
  const snap = await snapshotDir(root);
  const proposals: readonly Proposal[] = [
    { kind: 'pack_edit', id: 'p', target: `../${outsideName}`, text: 'owned', provenance: ['s#0'] },
  ];
  const res = await applyProposals(root, proposals, allow, { sids: ['s'] });
  assert.equal(res.applied.length, 0);
  assert.ok(res.problems?.some((p) => /unsafe proposal target/i.test(p)));
  await assert.rejects(() => readFile(outside, 'utf8'));
  assert.deepEqual(await snapshotDir(root), snap);
});

test('proposal edits cannot target pack.json or provenance sidecar files', async () => {
  const root = await makePack();
  const proposals: readonly Proposal[] = [
    { kind: 'pack_edit', id: 'manifest', target: 'pack.json', text: '{}', provenance: ['s#0'] },
    { kind: 'pack_edit', id: 'prov', target: '.evolve/provenance.jsonl', text: '{}', provenance: ['s#0'] },
  ];
  const res = await applyProposals(root, proposals, allow, { sids: ['s'] });
  assert.equal(res.applied.length, 0);
  assert.ok(res.problems?.some((p) => /system-owned/i.test(p)));
});

test('pack.json and provenance writes are gated separately from proposal writes', async () => {
  const root = await makePack();
  const snap = await snapshotDir(root);
  const gate: Gate = async (p) => (p.id.startsWith('system:') ? 'deny' : 'allow');
  const proposals: readonly Proposal[] = [
    { kind: 'pack_edit', id: 'p', target: 'persona.md', text: '\nA\n', provenance: ['s#0'] },
  ];
  const res = await applyProposals(root, proposals, gate, { sids: ['s'] });
  assert.equal(res.applied.length, 0);
  assert.ok(res.problems?.some((p) => /system write denied/i.test(p)));
  assert.deepEqual(await snapshotDir(root), snap);
});

test('revert restores the pack byte-identically and pops the provenance record', async () => {
  const root = await makePack();
  const before = await snapshotDir(root);
  const proposals: readonly Proposal[] = [
    {
      kind: 'pack_edit',
      id: 'prop#0',
      target: 'persona.md',
      text: '\n## Learned constraints\n\n- Lead with the band score.\n',
      provenance: ['s#0'],
    },
    { kind: 'memory_promote', id: 'prop#1', fact: 'User wants IELTS band 7.', from: 'l1', to: 'l2', provenance: ['s#1'] },
  ];
  const res = await applyProposals(root, proposals, allow, { sids: ['s'] });
  assert.equal(res.applied.length, 2);
  // The promotion created memory/l2.md.
  assert.match(await readFile(join(root, 'memory/l2.md'), 'utf8'), /User wants IELTS band 7\./);

  await revert(root);
  const after = await snapshotDir(root);
  assert.deepEqual(after, before, 'revert must restore byte-identical declared files');
});

test('provenance records carry version, prevVersion, proposal + observation ids and sids', async () => {
  const root = await makePack();
  const proposals: readonly Proposal[] = [
    { kind: 'pack_edit', id: 'prop#0', target: 'persona.md', text: '\nA\n', provenance: ['s#0', 's#1'] },
  ];
  await applyProposals(root, proposals, allow, { sids: ['sess-1'] });
  const lines = (await readFile(join(root, '.evolve/provenance.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!);
  assert.equal(rec.schema, 1);
  assert.equal(rec.prevVersion, '1.0.0');
  assert.equal(rec.version, '1.0.1');
  assert.deepEqual(rec.proposals, ['prop#0']);
  assert.deepEqual(rec.observations, ['s#0', 's#1']);
  assert.deepEqual(rec.sids, ['sess-1']);
});

test('applyProposals records an EvolutionRun with decisions, metrics, provenance, and activation evidence', async () => {
  const root = await makePack();
  const proposals: readonly Proposal[] = [
    { kind: 'pack_edit', id: 'prop#0', target: 'persona.md', text: '\n## Learned constraints\n\n- Lead with outcomes.\n', provenance: ['s#0'] },
    { kind: 'pack_edit', id: 'prop#1', target: 'rubrics/unknown.prompt.md', text: '\nBad\n', provenance: ['s#1'] },
  ];
  const res = await applyProposals(root, proposals, allow, { sids: ['sess-1'], datasets: ['holdout-mini'] });
  assert.deepEqual([...res.applied], ['prop#0']);
  assert.ok(res.problems?.some((p) => /not declared by pack manifest/i.test(p)));

  const lines = (await readFile(join(root, '.evolve/runs.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1);
  const run = JSON.parse(lines[0]!);
  assert.equal(run.schema, 1);
  assert.equal(run.baselineVersion, '1.0.0');
  assert.deepEqual(run.candidateIds, ['prop#0', 'prop#1']);
  assert.deepEqual(run.datasetIds, ['sess-1', 'holdout-mini']);
  assert.ok(run.metrics.some((m: { name: string }) => m.name === 'token_delta'));
  assert.ok(run.decisions.some((d: { candidateId: string; verdict: string }) => d.candidateId === 'prop#0' && d.verdict === 'accepted'));
  assert.ok(run.decisions.some((d: { candidateId: string; verdict: string }) => d.candidateId === 'prop#1' && d.verdict === 'rejected'));
  assert.ok(run.activationEvidence.some((e: { candidateId: string; surface: string }) => e.candidateId === 'prop#0' && e.surface === 'system_prompt'));
});

test('a proposal that breaks validation is rolled back and reported, version intact', async () => {
  const root = await makePack();
  const snap = await snapshotDir(root);
  // Append 6 negative constraints to the persona — over the budget of 5 — so
  // validatePack rejects the mutated pack and apply must roll back.
  const overBudget = ['', '## Bad', '', "- Don't a", "- Don't b", "- Don't c", "- Don't d", "- Don't e", "- Don't f", ''].join('\n');
  const proposals: readonly Proposal[] = [
    { kind: 'pack_edit', id: 'p', target: 'persona.md', text: overBudget, provenance: ['s#0'] },
  ];
  const res = await applyProposals(root, proposals, allow, { sids: ['s'] });
  assert.equal(res.applied.length, 0);
  assert.ok(res.problems && res.problems.length > 0);
  assert.deepEqual(await snapshotDir(root), snap, 'failed validation must leave the pack untouched');
});
