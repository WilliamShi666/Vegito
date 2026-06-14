import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generatePack } from '../../src/forge/generate.ts';
import { getArchetype } from '../../src/forge/templates/index.ts';
import { blueprintToSpec } from '../../src/forge/native-blueprint.ts';
import { loadPack } from '../../src/extend/packs.ts';
import { buildSystemTiers } from '../../src/ui/cli/runtime-support.ts';

test('forged pack artifacts beyond persona reach the active system prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vegito-active-pack-'));
  const spec = getArchetype('tutor-team')({ domain: 'TOEFL speaking 1-6 band scoring' });
  await generatePack(root, spec);

  const pack = await loadPack(root);
  const tiers = await buildSystemTiers(root, root, [pack]);
  const system = tiers.join('\n');

  assert.match(system, /Persona for/);
  assert.match(system, /Role prompt: examiner/);
  assert.match(system, /You are the examiner for TOEFL speaking 1-6 band scoring/);
  assert.match(system, /Rubric: band-score/);
  assert.match(system, /For each criterion give a band 1-6/);
  assert.match(system, /Onboarding for/);
  assert.match(system, /The first session establishes a baseline band/);
  assert.match(system, /Memory seeds for/);
  assert.match(system, /Track recurring error types/);
});

test('native data-science artifact and verification contracts reach the active system prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vegito-active-native-data-'));
  const spec = blueprintToSpec({
    schema: 1,
    name: 'native-data-science-team',
    version: '1.0.0',
    description: 'A native generated data-science analysis harness.',
    targetUser: 'An analyst who needs a trustworthy first pass on a dataset.',
    jobToBeDone: 'Turn raw data into evidence-backed findings with reproducible artifacts.',
    taskTaxonomy: ['data intake', 'schema and data quality checks', 'EDA', 'causal caution', 'artifact delivery'],
    modes: [
      { name: 'intake', trigger: 'new dataset', workflow: ['capture question', 'inspect schema'], output: 'analysis plan' },
      { name: 'eda', trigger: 'schema is known', workflow: ['profile quality', 'summarize distributions'], output: 'evidence table' },
    ],
    routing: ['Run intake before EDA when schema or question is unclear.'],
    roles: [
      {
        name: 'data-steward',
        tier: 'fast',
        tools: ['fs.read'],
        mission: 'Protect analysis from bad inputs.',
        workflow: ['inspect files', 'check schema', 'flag quality risks'],
        outputContract: ['Report schema and data quality issues.'],
      },
      {
        name: 'analyst',
        tier: 'smart',
        tools: ['fs.read'],
        mission: 'Produce evidence-backed findings.',
        workflow: ['run EDA', 'cite statistics', 'name limitations'],
        outputContract: ['Every claim cites evidence.'],
      },
    ],
    rubrics: [
      {
        name: 'analysis-completeness',
        prompt: 'Check schema, data quality, EDA, evidence, causal caution, artifacts, and reproducibility.',
        requiredSignals: ['schema', 'data quality', 'eda', 'evidence', 'causal', 'artifact', 'reproducibility'],
      },
    ],
    qualityGates: ['Schema and data quality before conclusions.', 'Reproducibility before final answer.'],
    dataQualityGates: ['Profile missingness and duplicates before EDA.', 'Validate schema before conclusions.'],
    evidenceContract: ['Every data claim cites a column, statistic, table, chart, or code output.'],
    errorTaxonomy: ['missing-data-context', 'schema-mismatch', 'data-quality-risk', 'unsupported-causal-claim'],
    memoryPolicy: { seeds: ['Track dataset assumptions and recurring quality risks.'], promotion: 'Promote repeated risks into checklist items.' },
    failurePolicy: ['Ask for missing dataset or schema before analysis.'],
    approvalGates: ['Ask before reading files outside provided dataset scope.'],
    toolGrants: ['fs.read'],
    artifactOutputs: [
      {
        name: 'data-quality-report',
        path: 'artifacts/data-quality.md',
        description: 'A human-readable data quality report.',
        requiredSignals: ['missingness', 'duplicates', 'schema'],
      },
    ],
    verificationPath: {
      steps: ['Restart kernel and run all cells.', 'Rebuild artifacts from raw data.'],
      successCriteria: ['artifact paths present', 'every claim cites a source column'],
    },
    commands: [{ name: 'analyze-dataset', description: 'Run dataset analysis workflow.', template: 'Analyze $ARGUMENTS.' }],
    examples: ['Analyze churn.csv and return an evidence table.'],
    evalCases: ['Reject causal claims from correlation-only evidence.'],
    tiers: { smart: 'the strongest available reasoning tier', fast: 'a quick tier' },
  });
  await generatePack(root, spec);

  const pack = await loadPack(root);
  const tiers = await buildSystemTiers(root, root, [pack]);
  const system = tiers.join('\n');

  assert.match(system, /Persona for native-data-science-team/);
  assert.match(system, /Data quality gates/);
  assert.match(system, /Profile missingness and duplicates before EDA/);
  assert.match(system, /Artifact outputs/);
  assert.match(system, /data-quality-report/);
  assert.match(system, /artifacts\/data-quality\.md/);
  assert.match(system, /Verification path/);
  assert.match(system, /Restart kernel and run all cells/);
  assert.match(system, /every claim cites a source column/);
  assert.match(system, /Role prompt: data-steward/);
  assert.match(system, /Rubric: analysis-completeness/);
});
