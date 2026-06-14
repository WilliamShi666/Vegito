import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactForProposal, validateProposalTarget } from '../../../src/evolve/artifacts.ts';
import { generatePack } from '../../../src/forge/generate.ts';
import { getArchetype } from '../../../src/forge/templates/index.ts';
import { loadPack } from '../../../src/extend/packs.ts';
import type { Proposal } from '../../../src/evolve/types.ts';

async function makePack() {
  const root = await mkdtemp(join(tmpdir(), 'evolve-artifacts-'));
  await generatePack(root, getArchetype('tutor-team')({ domain: 'IELTS writing' }));
  return loadPack(root);
}

test('artifactForProposal maps concrete proposals to typed artifact adapters', async () => {
  const pack = await makePack();
  const persona: Proposal = { kind: 'pack_edit', id: 'p0', target: 'persona.md', text: '\nA\n', provenance: ['s#0'] };
  const rubric: Proposal = {
    kind: 'pack_edit',
    id: 'p1',
    target: 'rubrics/band-score.prompt.md',
    text: '\nB\n',
    provenance: ['s#1'],
  };
  const memory: Proposal = { kind: 'memory_promote', id: 'p2', fact: 'User wants band 7.', from: 'l1', to: 'l2', provenance: ['s#2'] };

  assert.equal(artifactForProposal(pack, persona).kind, 'prompt_persona');
  assert.equal(artifactForProposal(pack, rubric).kind, 'rubric');
  assert.equal(artifactForProposal(pack, memory).kind, 'memory_policy');
});

test('validateProposalTarget rejects hostile, undeclared, and system-owned targets', async () => {
  const pack = await makePack();
  const good: Proposal = { kind: 'pack_edit', id: 'ok', target: 'persona.md', text: '\nA\n', provenance: ['s#0'] };
  const badPath: Proposal = { kind: 'pack_edit', id: 'bad-path', target: '../outside.md', text: '\nB\n', provenance: ['s#1'] };
  const system: Proposal = { kind: 'pack_edit', id: 'system', target: 'pack.json', text: '{}', provenance: ['s#2'] };
  const undeclared: Proposal = {
    kind: 'pack_edit',
    id: 'unknown',
    target: 'rubrics/made-up.prompt.md',
    text: '\nC\n',
    provenance: ['s#3'],
  };

  assert.equal((await validateProposalTarget(pack, good)).ok, true);
  const badPathResult = await validateProposalTarget(pack, badPath);
  assert.equal(badPathResult.ok, false);
  if (!badPathResult.ok) assert.match(badPathResult.reason, /unsafe proposal target/i);
  const systemResult = await validateProposalTarget(pack, system);
  assert.equal(systemResult.ok, false);
  if (!systemResult.ok) assert.match(systemResult.reason, /system-owned/i);
  const undeclaredResult = await validateProposalTarget(pack, undeclared);
  assert.equal(undeclaredResult.ok, false);
  if (!undeclaredResult.ok) assert.match(undeclaredResult.reason, /not declared by pack manifest/i);
});

test('validator and source patch adapters exist but do not allow append-only mutations yet', async () => {
  const pack = await makePack();
  const validator: Proposal = {
    kind: 'pack_edit',
    id: 'validator',
    target: 'rubrics/band-score.validator.mjs',
    text: '\nconsole.log("changed")\n',
    provenance: ['s#0'],
  };
  const result = await validateProposalTarget(pack, validator);
  assert.equal(artifactForProposal(pack, validator).kind, 'validator');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /validator edits require/i);
});

test('memory promotions are valid even before a pack has a memory directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'evolve-artifacts-nomem-'));
  await writeFile(
    join(root, 'pack.json'),
    JSON.stringify({
      schema: 1,
      name: 'minimal',
      version: '1.0.0',
      description: 'minimal pack',
      grants: [],
      agents: [],
      rubrics: [],
      modelTiers: {},
    }),
    'utf8',
  );
  const pack = await loadPack(root);
  const promotion: Proposal = {
    kind: 'memory_promote',
    id: 'mem',
    fact: 'User likes concise feedback.',
    from: 'l1',
    to: 'l2',
    provenance: ['s#0'],
  };
  assert.equal((await validateProposalTarget(pack, promotion)).ok, true);
});
