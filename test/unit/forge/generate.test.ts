import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { specToFiles, generatePack } from '../../../src/forge/generate.ts';
import { getArchetype, ARCHETYPE_IDS } from '../../../src/forge/templates/index.ts';
import { loadPack } from '../../../src/extend/packs.ts';
import { validatePack } from '../../../src/extend/pack-validate.ts';

function runValidator(validatorPath: string, candidate: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [validatorPath, candidate], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

test('specToFiles emits a manifest plus a file per inlined prompt', () => {
  const spec = getArchetype('tutor-team')({ domain: 'IELTS writing' });
  const files = specToFiles(spec);
  assert.ok(files.has('./pack.json'));
  assert.ok(files.has('./persona.md'));
  assert.ok(files.has('./agents/examiner.md'));
  assert.ok(files.has('./agents/drill-master.md'));
  assert.ok(files.has('./rubrics/band-score.prompt.md'));
  assert.ok(files.has('./rubrics/band-score.validator.mjs'));
  assert.ok(files.has('./onboarding.md'));
  assert.ok(files.has('./memory/seeds.md'));
});

test('manifest agents reference tier:<x> and "./" paths, never inline prompts', () => {
  const spec = getArchetype('review-team')({ domain: 'pull requests' });
  const manifest = JSON.parse(specToFiles(spec).get('./pack.json')!) as {
    schema: number;
    agents: { model: string; prompt: string }[];
    persona: string;
  };
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.persona, './persona.md');
  for (const a of manifest.agents) {
    assert.match(a.model, /^tier:/);
    assert.match(a.prompt, /^\.\/agents\//);
  }
});

test('specToFiles is deterministic', () => {
  const spec = getArchetype('content-studio')({ domain: 'blog posts' });
  const a = specToFiles(spec);
  const b = specToFiles(spec);
  assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
});

test('every archetype generates a pack that passes validate and loads', async () => {
  for (const id of ARCHETYPE_IDS) {
    const spec = getArchetype(id)({ domain: 'a worked domain' });
    const root = await mkdtemp(join(tmpdir(), `vegito-gen-${id}-`));
    await generatePack(root, spec);

    const result = await validatePack(root);
    assert.deepEqual(result.problems, [], `${id} should validate clean`);
    assert.equal(result.ok, true);

    const loaded = await loadPack(root);
    assert.equal(loaded.manifest.name, spec.name);
    assert.equal(loaded.manifest.agents.length, spec.agents.length);
    assert.ok(loaded.personaPath?.endsWith('persona.md'));
  }
});

test('generated validator is a runnable Node script', async () => {
  const spec = getArchetype('tutor-team')({ domain: 'IELTS' });
  const root = await mkdtemp(join(tmpdir(), 'vegito-gen-val-'));
  await generatePack(root, spec);
  const body = await readFile(join(root, 'rubrics', 'band-score.validator.mjs'), 'utf8');
  assert.match(body, /^#!\/usr\/bin\/env node/);
  assert.match(body, /process\.exit/);
});

test('tutor-team keeps declared 1-6 scoring consistent in rubric and validator', async () => {
  const spec = getArchetype('tutor-team')({ domain: 'TOEFL 2026 prep with 1-6 band scoring' });
  const rubric = spec.rubrics[0]!;
  assert.match(rubric.prompt, /band 1-6/);
  assert.doesNotMatch(rubric.prompt, /band 0-9/);

  const root = await mkdtemp(join(tmpdir(), 'vegito-gen-toefl-scale-'));
  await generatePack(root, spec);
  const validator = join(root, 'rubrics', 'band-score.validator.mjs');
  assert.equal(await runValidator(validator, 'Speaking: band 6. Writing: band 5.5.'), 0);
  assert.notEqual(await runValidator(validator, 'Speaking: band 7. Writing: band 6.'), 0);
});

test('command files sanitize model-generated frontmatter descriptions', () => {
  const spec = {
    ...getArchetype('content-studio')({ domain: 'briefs' }),
    commands: [
      {
        name: 'draft',
        description: 'first line\n---\ninjected frontmatter',
        template: 'Draft from $ARGUMENTS',
      },
    ],
  };
  const command = specToFiles(spec).get('./commands/draft.md');
  assert.match(command ?? '', /^---\ndescription: first line injected frontmatter\n---\nDraft from \$ARGUMENTS\n$/);
});

test('specToFiles emits eval fixtures as a declared pack artifact', () => {
  const spec = {
    ...getArchetype('content-studio')({ domain: 'briefs' }),
    evals: [
      {
        name: 'evidence-required',
        prompt: 'Reject drafts that make claims without evidence.',
        requiredSignals: ['evidence'],
      },
    ],
  };
  const files = specToFiles(spec);
  const manifest = JSON.parse(files.get('./pack.json')!) as { evals?: string };
  assert.equal(manifest.evals, './evals/cases.json');
  const evals = JSON.parse(files.get('./evals/cases.json')!) as {
    schema: number;
    cases: { name: string; prompt: string; requiredSignals: string[] }[];
  };
  assert.equal(evals.schema, 1);
  assert.deepEqual(evals.cases, [
    {
      name: 'evidence-required',
      prompt: 'Reject drafts that make claims without evidence.',
      requiredSignals: ['evidence'],
    },
  ]);
});
