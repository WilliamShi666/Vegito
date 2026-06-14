import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { scriptedText } from '../../src/providers/wire/scripted.ts';
import { blueprintToSpec } from '../../src/forge/native-blueprint.ts';
import { generatePack } from '../../src/forge/generate.ts';

async function scriptFile(steps: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-native-runtime-script-'));
  const file = join(dir, 'script.json');
  await writeFile(file, JSON.stringify(steps), 'utf8');
  return file;
}

function portsFor(extra: Partial<DispatchPorts>): { readonly out: string[]; readonly err: string[]; readonly ports: DispatchPorts } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    ports: {
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      homeDir: extra.homeDir ?? '/nonexistent-home',
      cwd: extra.cwd ?? '/nonexistent-cwd',
      signal: new AbortController().signal,
      ...extra,
    },
  };
}

test('native TOEFL commands persist and reuse memory across REPL slash workflows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-native-toefl-'));
  const pack = join(home, 'toefl-pack');
  const spec = blueprintToSpec({
    schema: 1,
    name: 'toefl-speaking-coach',
    version: '1.0.0',
    description: 'A TOEFL speaking practice harness.',
    targetUser: 'A learner preparing for TOEFL speaking.',
    jobToBeDone: 'Diagnose attempts, assign drills, and improve the study plan from history.',
    taskTaxonomy: ['score history intake', 'recurring weakness diagnosis', 'drill outcome review', 'study-plan update'],
    modes: [
      {
        name: 'diagnose',
        trigger: 'Learner submits a speaking answer.',
        workflow: ['score the answer', 'cite evidence', 'save weakness and drill outcome memory'],
        output: 'Score, evidence, error taxonomy, drill, and memory update.',
      },
      {
        name: 'review',
        trigger: 'Learner asks what to practice next.',
        workflow: ['read prior memory', 'find recurring weaknesses', 'update the plan'],
        output: 'Study-plan review grounded in memory.',
      },
    ],
    routing: ['Use diagnose for new attempts and review for planning.'],
    roles: [
      {
        name: 'toefl-memory-coach',
        tier: 'smart',
        tools: ['memory'],
        mission: 'Maintain score history, recurring weaknesses, drill outcomes, and study-plan updates.',
        workflow: ['save diagnosis memory', 'read history before review', 'promote repeated weakness patterns'],
        outputContract: ['State the memory item read or written.'],
      },
    ],
    rubrics: [
      {
        name: 'toefl-feedback',
        prompt: 'Check score, evidence, recurring weakness, drill outcome, and study plan.',
        requiredSignals: ['score history', 'recurring weakness', 'drill outcome', 'study plan'],
      },
    ],
    qualityGates: ['Do not update the plan without citing prior memory or the current attempt.'],
    evidenceContract: ['Every diagnosis cites learner behavior or memory history.'],
    errorTaxonomy: ['limited-development', 'fluency-breakdown', 'unclear-example'],
    memoryPolicy: {
      seeds: ['Track score history, recurring weaknesses, drill outcomes, and study-plan updates.'],
      promotion: 'Promote a weakness into the study plan when it appears in two sessions.',
    },
    failurePolicy: ['Ask for a speaking answer before scoring.'],
    approvalGates: ['Ask before saving personally identifying details.'],
    toolGrants: [],
    commands: [
      {
        name: 'diagnose',
        description: 'Diagnose a TOEFL speaking attempt and save durable learning memory.',
        template: 'Diagnose this TOEFL attempt: $ARGUMENTS. Return score history, recurring weakness, drill outcome, and study plan update.',
      },
      {
        name: 'review',
        description: 'Review TOEFL progress from saved memory and update the next study plan.',
        template: 'Review saved TOEFL progress for $ARGUMENTS. Return score history, recurring weakness, drill outcome, and study plan.',
      },
    ],
    examples: ['Diagnose a speaking answer and then review the next practice plan.'],
    evalCases: ['Reject a study plan that ignores score history or recurring weakness memory.'],
    tiers: { smart: 'the strongest available reasoning tier', fast: 'a quick tier' },
  });
  await generatePack(pack, spec);

  const validate = portsFor({ homeDir: home, cwd: home });
  assert.equal(await dispatch(['packs', 'validate', pack], validate.ports), 0);
  assert.match(validate.out.join(''), /valid/);

  const script = await scriptFile([
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        {
          t: 'tool_call',
          callId: 'm1',
          name: 'memory',
          input: {
            action: 'save',
            name: 'toefl-weaknesses',
            content:
              'score history: 18 -> 20\nrecurring weakness: limited development\ndrill outcome: contrast drill worked\nstudy plan: daily example expansion',
          },
        },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    { kind: 'events', events: scriptedText('diagnosis stored with score history, recurring weakness, drill outcome, and study plan') },
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'tool_call', callId: 'm2', name: 'memory', input: { action: 'read', name: 'toefl-weaknesses' } },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    {
      kind: 'events',
      events: scriptedText('review used memory: score history, recurring weakness, drill outcome, and study plan are carried forward'),
    },
  ]);
  const lines: (string | null)[] = ['/toefl-diagnose sample speaking answer', '/toefl-review next week', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: home, nextLine: async () => lines[index++] ?? null });

  const code = await dispatch(['repl', '--pack', pack, '--script', script, '--mode', 'bypass'], run.ports);

  assert.equal(code, 0);
  const text = run.out.join('');
  assert.match(text, /diagnosis stored/);
  assert.match(text, /review used memory/);
  assert.equal(
    await readFile(join(home, '.vegito', 'memory', 'toefl-weaknesses.md'), 'utf8'),
    'score history: 18 -> 20\nrecurring weakness: limited development\ndrill outcome: contrast drill worked\nstudy plan: daily example expansion',
  );
});

test('native churn data-science command reads local data, writes artifacts, saves memory, and validates output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-native-data-'));
  await mkdir(join(home, 'data'), { recursive: true });
  await writeFile(
    join(home, 'data', 'churn.csv'),
    ['customer_id,tenure_months,monthly_charges,churned', '1,3,80,1', '2,20,45,0', '3,8,70,1'].join('\n'),
    'utf8',
  );
  const pack = join(home, 'churn-pack');
  const spec = blueprintToSpec({
    schema: 1,
    name: 'customer-churn-data-science-team',
    version: '1.0.0',
    description: 'A customer churn data-science analysis harness.',
    targetUser: 'A data science team analyzing local customer data.',
    jobToBeDone: 'Run a local, reproducible churn analysis with quality checks and artifacts.',
    taskTaxonomy: ['dataset intake', 'schema inspection', 'data quality checks', 'EDA', 'causal review', 'artifact delivery'],
    modes: [
      {
        name: 'pipeline',
        trigger: 'A local dataset path is provided.',
        workflow: ['read dataset', 'inspect schema', 'run quality checks', 'write artifacts', 'save assumptions'],
        output: 'Validated churn analysis artifact summary.',
      },
    ],
    routing: ['Use the full pipeline whenever a CSV path is supplied.'],
    roles: [
      {
        name: 'schema-inspector',
        tier: 'fast',
        tools: [],
        mission: 'Inspect local churn dataset schema and assumptions.',
        workflow: ['read dataset', 'list columns', 'flag missing schema context'],
        outputContract: ['Report schema and dataset assumptions.'],
      },
      {
        name: 'data-quality-gatekeeper',
        tier: 'smart',
        tools: [],
        mission: 'Run quality checks and write local reports.',
        workflow: ['profile missingness', 'check duplicates', 'write quality artifact'],
        outputContract: ['Report quality_pass or quality risks.'],
      },
      {
        name: 'reproducibility-verifier',
        tier: 'smart',
        tools: [],
        mission: 'Save assumptions, artifact status, and reproducibility findings.',
        workflow: ['record artifact status', 'save memory', 'verify rerun path'],
        outputContract: ['State artifact paths and reproducibility status.'],
      },
    ],
    rubrics: [
      {
        name: 'churn-analysis-completeness',
        prompt: 'Check schema, data quality, EDA, evidence, causal caution, artifacts, and reproducibility.',
        requiredSignals: ['schema', 'data quality', 'eda', 'evidence', 'causal', 'artifact', 'reproducibility'],
      },
    ],
    qualityGates: ['Schema and data quality checks must precede conclusions.', 'Causal claims must be marked as unsupported unless designed evidence exists.'],
    dataQualityGates: ['Profile missingness.', 'Check duplicate rows.', 'Confirm target column.'],
    evidenceContract: ['Every finding cites a source column or computed statistic.'],
    errorTaxonomy: ['schema-mismatch', 'missingness-risk', 'duplicate-risk', 'unsupported-causal-claim'],
    memoryPolicy: {
      seeds: ['Track dataset assumptions, schema notes, quality risks, causal rejections, artifact status, and reproducibility findings.'],
      promotion: 'Promote repeated quality risks into a reusable analysis checklist.',
    },
    failurePolicy: ['Ask for the dataset path before analysis.'],
    approvalGates: ['Ask before reading outside the provided dataset scope.'],
    toolGrants: [],
    artifactOutputs: [
      {
        name: 'data-quality-report',
        path: 'artifacts/data-quality.md',
        description: 'A data quality report for the churn dataset.',
        requiredSignals: ['missingness', 'duplicates', 'schema'],
      },
      {
        name: 'analysis-report',
        path: 'artifacts/report.md',
        description: 'A reproducible churn analysis report.',
        requiredSignals: ['quality_pass', 'eda_complete', 'causal_review'],
      },
    ],
    verificationPath: {
      steps: ['Re-run checks from the raw CSV.', 'Confirm artifacts were written.'],
      successCriteria: ['artifact paths present', 'every claim cites a source column'],
    },
    commands: [
      {
        name: 'run-pipeline',
        description: 'Run the complete local churn analysis workflow.',
        template: 'Run the churn pipeline on $ARGUMENTS. Read data, check schema and data quality, write artifacts, save memory, and return validation signals.',
      },
    ],
    examples: ['Run the churn pipeline on data/churn.csv.'],
    evalCases: ['Reject outputs that skip schema, data quality, artifacts, or reproducibility.'],
    tiers: { smart: 'the strongest available reasoning tier', fast: 'a quick tier' },
  });
  await generatePack(pack, spec);

  const validate = portsFor({ homeDir: home, cwd: home });
  assert.equal(await dispatch(['packs', 'validate', pack], validate.ports), 0);
  assert.deepEqual([...spec.grants].sort(), ['bash', 'glob', 'ls', 'memory', 'read', 'write']);

  const script = await scriptFile([
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        { t: 'tool_call', callId: 'd1', name: 'read', input: { file_path: 'data/churn.csv' } },
        {
          t: 'tool_call',
          callId: 'd2',
          name: 'bash',
          input: {
            command:
              'node -e "const fs=require(\'fs\'); const rows=fs.readFileSync(\'data/churn.csv\',\'utf8\').trim().split(/\\\\n/); console.log(`rows=${rows.length-1}`); console.log(`columns=${rows[0]}`);"',
          },
        },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        {
          t: 'tool_call',
          callId: 'd3',
          name: 'write',
          input: {
            file_path: 'artifacts/data-quality.md',
            content: 'schema checked\nmissingness: none\nduplicates: none\ndata quality: quality_pass',
          },
        },
        {
          t: 'tool_call',
          callId: 'd4',
          name: 'write',
          input: {
            file_path: 'artifacts/report.md',
            content: 'schema customer_id, tenure_months, monthly_charges, churned\ndata quality quality_pass\neda_complete\ncausal_review: correlation only\nartifact paths present',
          },
        },
        {
          t: 'tool_call',
          callId: 'd5',
          name: 'memory',
          input: {
            action: 'save',
            name: 'churn-dataset-notes',
            content:
              'dataset assumptions: churn.csv has customer-level rows\nschema notes: customer_id, tenure_months, monthly_charges, churned\nquality risks: small sample\ncausal rejections: no causal claim without experiment\nartifact status: artifacts written\nreproducibility findings: rerun command captured',
          },
        },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    {
      kind: 'events',
      events: scriptedText(
        [
          'schema data quality eda evidence causal artifact reproducibility',
          'data-quality-report artifacts/data-quality.md missingness duplicates schema',
          'analysis-report artifacts/report.md quality_pass eda_complete causal_review',
          'artifact paths present every claim cites a source column',
        ].join('\n'),
      ),
    },
  ]);
  const lines: (string | null)[] = ['/churn-run-pipeline data/churn.csv', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: home, nextLine: async () => lines[index++] ?? null });

  assert.equal(await dispatch(['repl', '--pack', pack, '--script', script, '--mode', 'bypass'], run.ports), 0);
  assert.match(await readFile(join(home, 'artifacts', 'data-quality.md'), 'utf8'), /quality_pass/);
  assert.match(await readFile(join(home, 'artifacts', 'report.md'), 'utf8'), /causal_review/);
  assert.match(await readFile(join(home, '.vegito', 'memory', 'churn-dataset-notes.md'), 'utf8'), /reproducibility findings/);

  const candidate = join(home, 'candidate-output.md');
  await writeFile(candidate, run.out.join(''), 'utf8');
  const validation = portsFor({ homeDir: home, cwd: home });
  assert.equal(await dispatch(['packs', 'validate-output', pack, candidate], validation.ports), 0);
  assert.match(validation.out.join(''), /output valid/);
});
