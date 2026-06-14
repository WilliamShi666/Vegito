import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { buildCallModel, dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { loadPack } from '../../src/extend/packs.ts';
import { createExtensionRegistry } from '../../src/extend/registry.ts';
import { scriptedText } from '../../src/providers/wire/scripted.ts';

function ports(extra: Partial<DispatchPorts> & { homeDir: string; cwd: string }): DispatchPorts {
  return {
    write: () => {},
    writeErr: () => {},
    signal: new AbortController().signal,
    ...extra,
  };
}

async function scriptFile(root: string, name: string, blueprint: unknown): Promise<string> {
  const file = join(root, `${name}.script.json`);
  await writeFile(file, JSON.stringify([{ kind: 'events', events: scriptedText(JSON.stringify(blueprint)) }]), 'utf8');
  return file;
}

async function collectFiles(root: string, sub = ''): Promise<string> {
  const chunks: string[] = [];
  for (const name of (await readdir(join(root, sub))).sort()) {
    const rel = sub === '' ? name : `${sub}/${name}`;
    const full = join(root, rel);
    const st = await stat(full);
    if (st.isDirectory()) chunks.push(await collectFiles(root, rel));
    else chunks.push(await readFile(full, 'utf8'));
  }
  return chunks.join('\n');
}

async function scorePack(root: string): Promise<{
  readonly score: number;
  readonly criteria: readonly string[];
  readonly commandCount: number;
  readonly agentCount: number;
  readonly rubricCount: number;
}> {
  const text = (await collectFiles(root)).toLowerCase();
  const criteria = [
    'task taxonomy',
    'modes',
    'routing',
    'quality gates',
    'evidence contract',
    'error taxonomy',
    'failure policy',
    'approval gates',
    'eval cases',
  ];
  const matched = criteria.filter((criterion) => text.includes(criterion));
  const pack = await loadPack(root);
  const registry = createExtensionRegistry();
  await registry.installPack(pack);
  const commandCount = registry.commands().list().length;
  return {
    score: matched.length + Math.min(commandCount, 2) + Math.min(pack.manifest.agents.length, 3) + Math.min(pack.manifest.rubrics.length, 2),
    criteria: matched,
    commandCount,
    agentCount: pack.manifest.agents.length,
    rubricCount: pack.manifest.rubrics.length,
  };
}

function relPath(p: string): string {
  return p.replace(/^\.\//, '').split('/').join(sep);
}

function runValidator(validatorPath: string, candidate: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [validatorPath, candidate], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function deepSeekMaxProbe(): Promise<{
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort: 'max';
  readonly url: string;
  readonly thinkingBudget: number;
}> {
  const savedDeepSeekKey = process.env['DEEPSEEK_API_KEY'];
  const savedAnthropicKey = process.env['ANTHROPIC_API_KEY'];
  const savedFetch = globalThis.fetch;
  let url = '';
  let body: Record<string, unknown> = {};
  process.env['DEEPSEEK_API_KEY'] = 'deepseek-e2e-dummy-token';
  delete process.env['ANTHROPIC_API_KEY'];
  globalThis.fetch = (async (input, init) => {
    url = String(input);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-pro","usage":{}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
    });
  }) as typeof fetch;
  try {
    const seam = await buildCallModel('deepseek-v4-pro', undefined, ['catalog/models.json']);
    for await (const _ of seam.callModel(
      {
        model: seam.modelId,
        system: [],
        messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'forge native trendline probe' }] }],
        tools: [],
        maxTokens: 4096,
        reasoning: 'max',
      },
      new AbortController().signal,
    )) void _;
    const thinking = body['thinking'] as { readonly budget_tokens?: number } | undefined;
    return {
      provider: seam.providerName,
      model: seam.modelId,
      reasoningEffort: 'max',
      url,
      thinkingBudget: thinking?.budget_tokens ?? 0,
    };
  } finally {
    globalThis.fetch = savedFetch;
    if (savedDeepSeekKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
    else process.env['DEEPSEEK_API_KEY'] = savedDeepSeekKey;
    if (savedAnthropicKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey;
  }
}

const languageExamBlueprint = {
  schema: 1,
  name: 'native-language-exam-coach',
  version: '1.0.0',
  description: 'A native generated language-exam coaching harness.',
  targetUser: 'A learner preparing for a high-stakes language exam.',
  jobToBeDone: 'Turn practice attempts into calibrated scores, error taxonomy, and drills.',
  taskTaxonomy: ['intake', 'diagnostic baseline', 'section practice', 'rubric scoring', 'drill loop'],
  modes: [
    { name: 'diagnose', trigger: 'new learner or unknown level', workflow: ['collect goal', 'score attempt', 'tag errors'], output: 'baseline and drill plan' },
    { name: 'drill', trigger: 'known weak skill', workflow: ['choose error type', 'assign drill', 'grade retry'], output: 'repeatable practice loop' },
  ],
  routing: ['Use diagnose before drill when no baseline exists.'],
  roles: [
    { name: 'intake-router', tier: 'fast', tools: [], mission: 'Route learner requests.', workflow: ['capture goal', 'select mode'], outputContract: ['State selected mode.'] },
    { name: 'rubric-calibrator', tier: 'smart', tools: [], mission: 'Score with evidence.', workflow: ['read attempt', 'score criteria', 'cite evidence'], outputContract: ['Every score cites evidence.'] },
    { name: 'drill-planner', tier: 'fast', tools: [], mission: 'Convert errors into drills.', workflow: ['pick error', 'write drill', 'define retry target'], outputContract: ['One drill targets one error.'] },
  ],
  rubrics: [
    {
      name: 'feedback-completeness',
      prompt: 'Check score, evidence, error taxonomy, and drill.',
      requiredSignals: ['score', 'evidence', 'error taxonomy', 'drill'],
      scoreScale: { label: 'band', min: 1, max: 6, increment: 0.5 },
    },
  ],
  qualityGates: ['Score before drill.', 'Evidence before diagnosis.'],
  evidenceContract: ['Every score cites observed learner behavior.'],
  errorTaxonomy: ['fluency', 'coherence', 'lexical-choice', 'grammar-control'],
  memoryPolicy: { seeds: ['Track recurring error taxonomy entries.'], promotion: 'Promote repeated errors into tracked weaknesses.' },
  failurePolicy: ['Ask for a learner attempt before scoring.'],
  approvalGates: ['Ask before storing personal learner details.'],
  toolGrants: [],
  commands: [{ name: 'baseline-attempt', description: 'Run baseline mode.', template: 'Baseline $ARGUMENTS with score, evidence, error taxonomy, and drill.' }],
  examples: ['Baseline one speaking or writing attempt.'],
  evalCases: ['Reject feedback with a score but no evidence.'],
  tiers: { smart: 'the strongest available reasoning tier', fast: 'a quick tier' },
};

const dataScienceBlueprint = {
  schema: 1,
  name: 'native-data-science-team',
  version: '1.0.0',
  description: 'A native generated data-science analysis harness.',
  targetUser: 'An analyst who needs a trustworthy first pass on a dataset.',
  jobToBeDone: 'Turn raw data into evidence-backed findings with reproducible artifacts.',
  taskTaxonomy: ['data intake', 'schema and data quality checks', 'EDA', 'causal caution', 'artifact delivery'],
  modes: [
    { name: 'intake', trigger: 'new dataset', workflow: ['capture question', 'inspect schema', 'name blockers'], output: 'analysis plan' },
    { name: 'eda', trigger: 'schema is known', workflow: ['profile data quality', 'summarize distributions', 'compare segments'], output: 'evidence table' },
  ],
  routing: ['Run intake before EDA when schema or question is unclear.'],
  roles: [
    { name: 'data-steward', tier: 'fast', tools: ['fs.read'], mission: 'Protect analysis from bad inputs.', workflow: ['inspect files', 'check schema', 'flag quality risks'], outputContract: ['Report schema and data quality issues.'] },
    { name: 'analyst', tier: 'smart', tools: ['fs.read'], mission: 'Produce evidence-backed findings.', workflow: ['run EDA', 'cite statistics', 'name limitations'], outputContract: ['Every claim cites evidence.'] },
    { name: 'statistician', tier: 'smart', tools: [], mission: 'Prevent causal overreach.', workflow: ['separate correlation from causation', 'check uncertainty'], outputContract: ['Mark unsupported causal claims.'] },
  ],
  rubrics: [{ name: 'analysis-completeness', prompt: 'Check intake, schema, data quality, EDA, evidence, causal caution, artifacts, and reproducibility.', requiredSignals: ['schema', 'data quality', 'eda', 'evidence', 'causal', 'artifact', 'reproducibility'] }],
  qualityGates: ['Schema and data quality before conclusions.', 'Reproducibility before final answer.'],
  evidenceContract: ['Every data claim cites a column, statistic, table, chart, or code output.'],
  errorTaxonomy: ['missing-data-context', 'schema-mismatch', 'data-quality-risk', 'unsupported-causal-claim'],
  memoryPolicy: { seeds: ['Track dataset assumptions and recurring quality risks.'], promotion: 'Promote repeated risks into checklist items.' },
  failurePolicy: ['Ask for missing dataset or schema before analysis.'],
  approvalGates: ['Ask before reading files outside provided dataset scope.'],
  toolGrants: ['fs.read'],
  dataQualityGates: ['Profile missingness and duplicates before EDA.', 'Validate schema before conclusions.'],
  artifactOutputs: [
    {
      name: 'data-quality-report',
      path: 'artifacts/data-quality.md',
      description: 'A human-readable data quality report.',
      requiredSignals: ['missingness', 'duplicates', 'schema'],
    },
    {
      name: 'analysis-notebook',
      path: 'notebooks/analysis.ipynb',
      description: 'A restartable analysis notebook.',
      requiredSignals: ['clean run', 'seed', 'environment'],
    },
  ],
  verificationPath: {
    steps: ['Restart kernel and run all cells.', 'Rebuild artifacts from raw data.'],
    successCriteria: ['artifact paths present', 'every claim cites a source column'],
  },
  commands: [{ name: 'analyze-dataset', description: 'Run dataset analysis workflow.', template: 'Analyze $ARGUMENTS with intake, schema, data quality, EDA, evidence, causal caution, artifacts, and reproducibility.' }],
  examples: ['Analyze churn.csv and return an evidence table.'],
  evalCases: ['Reject causal claims from correlation-only evidence.'],
  tiers: { smart: 'the strongest available reasoning tier', fast: 'a quick tier' },
};

test('forge native E2E trendline compares current-style vs native first drafts across two domains', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-forge-native-trendline-'));
  const domains = [
    {
      id: 'language-exam',
      request: 'language exam speaking coach',
      blueprint: languageExamBlueprint,
    },
    {
      id: 'data-science',
      request: 'customer churn dataset analysis team',
      blueprint: dataScienceBlueprint,
    },
  ];

  const rows = [];
  for (const domain of domains) {
    const current = join(home, `${domain.id}-current`);
    const native = join(home, `${domain.id}-native`);
    const script = await scriptFile(home, domain.id, domain.blueprint);

    assert.equal(
      await dispatch(['forge', '--offline', '--domain', domain.request, '--out', current], ports({ homeDir: home, cwd: home })),
      0,
    );
    assert.equal(
      await dispatch(['forge', '--native', '--domain', domain.request, '--script', script, '--out', native], ports({ homeDir: home, cwd: home })),
      0,
    );

    const currentScore = await scorePack(current);
    const nativeScore = await scorePack(native);
    assert.ok(nativeScore.score > currentScore.score, `${domain.id} native score should improve over current scaffold`);
    assert.ok(nativeScore.criteria.length >= 8, `${domain.id} native pack should expose blueprint structure`);
    if (domain.id === 'language-exam') {
      const nativePack = await loadPack(native);
      const validator = nativePack.manifest.rubrics[0]?.validator;
      assert.ok(validator, 'language-exam native pack should declare a rubric validator');
      const validatorPath = join(nativePack.root, relPath(validator));
      assert.equal(await runValidator(validatorPath, 'score evidence error taxonomy drill band 6 band 5.5'), 0);
      assert.notEqual(await runValidator(validatorPath, 'score evidence error taxonomy drill band 7'), 0);
    }
    if (domain.id === 'data-science') {
      const nativePack = await loadPack(native);
      const validator = nativePack.manifest.rubrics[0]?.validator;
      assert.ok(validator, 'data-science native pack should declare a rubric validator');
      const validatorPath = join(nativePack.root, relPath(validator));
      assert.equal(
        await runValidator(
          validatorPath,
          [
            'schema data quality eda evidence causal artifact reproducibility',
            'data-quality-report artifacts/data-quality.md missingness duplicates',
            'analysis-notebook notebooks/analysis.ipynb clean run seed environment',
            'artifact paths present every claim cites a source column',
          ].join('\n'),
        ),
        0,
      );
      assert.notEqual(
        await runValidator(validatorPath, 'schema data quality eda evidence causal artifact reproducibility clean run'),
        0,
      );
    }
    rows.push({ domain: domain.id, current: currentScore, native: nativeScore });
  }

  const probe = await deepSeekMaxProbe();
  const trendline = {
    provider: probe.provider,
    model: probe.model,
    reasoningEffort: probe.reasoningEffort,
    comparisons: rows,
    deepSeekProbe: {
      url: probe.url,
      thinkingBudget: probe.thinkingBudget,
    },
  };
  const report = join(home, 'forge-native-trendline.report.json');
  await writeFile(report, `${JSON.stringify(trendline, null, 2)}\n`, 'utf8');
  const persisted = JSON.parse(await readFile(report, 'utf8')) as typeof trendline;

  assert.equal(persisted.model, 'deepseek-v4-pro');
  assert.equal(persisted.reasoningEffort, 'max');
  assert.equal(persisted.deepSeekProbe.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(persisted.deepSeekProbe.thinkingBudget, 65536);
  assert.equal(persisted.comparisons.length, 2);
});
