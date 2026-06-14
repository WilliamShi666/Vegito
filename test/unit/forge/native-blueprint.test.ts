import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { blueprintToSpec, forgeNativeSpec, parseBlueprintText } from '../../../src/forge/native-blueprint.ts';
import type { NeutralRequest, ProviderEvent } from '../../../src/providers/types.ts';

const blueprint = {
  schema: 1,
  name: 'native-toefl-speaking',
  version: '1.0.0',
  description: 'A native generated speaking-test harness.',
  targetUser: 'A learner preparing for a speaking exam.',
  jobToBeDone: 'Convert attempts into calibrated feedback and repeatable drills.',
  taskTaxonomy: [
    'intake current score, target score, deadline, and known weak question types',
    'baseline scoring with explicit evidence by criterion',
    'error taxonomy update and targeted drill assignment',
  ],
  modes: [
    {
      name: 'baseline',
      trigger: 'The learner provides a first response or asks where to start.',
      workflow: ['collect prompt and response', 'score by criterion', 'identify highest-leverage weakness'],
      output: 'A scored baseline and one drill plan.',
    },
  ],
  routing: ['Start with baseline unless the learner asks for a specific drill.'],
  roles: [
    {
      name: 'intake-router',
      tier: 'fast',
      tools: [],
      mission: 'Choose the right practice mode from sparse learner input.',
      workflow: ['extract target', 'extract deadline', 'route to baseline or drill'],
      outputContract: ['State selected mode and missing intake fields.'],
    },
    {
      name: 'rubric-calibrator',
      tier: 'smart',
      tools: [],
      mission: 'Score attempts against the exam rubric with cited evidence.',
      workflow: ['read prompt', 'read response', 'score criteria', 'cite evidence'],
      outputContract: ['Every score cites a phrase or behavior from the attempt.'],
    },
  ],
  rubrics: [
    {
      name: 'speaking-feedback',
      prompt: 'Check that feedback includes score, evidence, error taxonomy, and drill.',
      requiredSignals: ['score', 'evidence', 'error taxonomy', 'drill'],
    },
  ],
  qualityGates: ['Feedback must cite evidence before assigning a drill.'],
  evidenceContract: ['Every score and diagnosis cites observed learner behavior.'],
  errorTaxonomy: ['fluency-breakdown', 'underdeveloped-example', 'pronunciation-confusion'],
  memoryPolicy: {
    seeds: ['Remember recurring speaking error types and successful drills.'],
    promotion: 'Promote repeated errors into tracked weaknesses after three sessions.',
  },
  failurePolicy: ['If no learner attempt is provided, ask for one before scoring.'],
  approvalGates: ['Ask before storing personally identifying learner details.'],
  toolGrants: [],
  commands: [
    {
      name: 'baseline-speaking',
      description: 'Run the baseline speaking workflow.',
      template: 'Run baseline mode on $ARGUMENTS, then return score, evidence, error taxonomy, and drill.',
    },
  ],
  examples: ['Baseline a 60-second speaking response and create one fluency drill.'],
  evalCases: ['Reject feedback that gives a score without evidence.'],
  tiers: {
    smart: 'the strongest available reasoning tier for rubric judgment',
    fast: 'a quick tier for routing and bookkeeping',
  },
};

function runValidator(validatorBody: string, candidate: string): Promise<number> {
  return mkdtemp(join(tmpdir(), 'vegito-native-validator-')).then(async (root) => {
    const file = join(root, 'validator.mjs');
    await writeFile(file, validatorBody, 'utf8');
    return new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [file, candidate], { stdio: 'ignore' });
      child.on('close', async (code) => {
        await rm(root, { recursive: true, force: true });
        resolve(code ?? 1);
      });
      child.on('error', async () => {
        await rm(root, { recursive: true, force: true });
        resolve(1);
      });
    });
  });
}

test('parseBlueprintText accepts fenced or raw JSON and rejects non-objects', () => {
  assert.equal(parseBlueprintText(JSON.stringify(blueprint)).ok, true);
  assert.equal(parseBlueprintText(`\`\`\`json\n${JSON.stringify(blueprint)}\n\`\`\``).ok, true);
  const bad = parseBlueprintText('[]');
  assert.equal(bad.ok, false);
});

test('blueprintToSpec compiles native model output into active pack artifacts without an archetype template', () => {
  const parsed = parseBlueprintText(JSON.stringify(blueprint));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  assert.equal(spec.name, 'native-toefl-speaking');
  assert.deepEqual(spec.agents.map((a) => a.name), ['intake-router', 'rubric-calibrator']);
  assert.equal(spec.rubrics[0]!.name, 'speaking-feedback');
  assert.equal(spec.commands?.[0]?.name, 'toefl-baseline-speaking');
  assert.equal(spec.evals?.[0]?.name, 'eval-1');

  const text = [
    spec.persona,
    spec.onboarding,
    ...spec.agents.map((a) => a.prompt),
    ...spec.rubrics.map((r) => r.prompt),
    spec.commands?.[0]?.template,
    spec.memory?.seeds?.join('\n'),
  ].join('\n');

  assert.match(text, /Target user/i);
  assert.match(text, /Job to be done/i);
  assert.match(text, /Task taxonomy/i);
  assert.match(text, /Modes/i);
  assert.match(text, /Routing/i);
  assert.match(text, /Quality gates/i);
  assert.match(text, /Evidence contract/i);
  assert.match(text, /Error taxonomy/i);
  assert.match(text, /Failure policy/i);
  assert.match(text, /Approval gates/i);
  assert.match(text, /Eval cases/i);
});

test('blueprintToSpec normalizes model-provided pack names to a safe slug', () => {
  const parsed = parseBlueprintText(JSON.stringify({ ...blueprint, name: 'Native Speaking Harness!' }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  assert.equal(spec.name, 'native-speaking-harness');
});

test('blueprintToSpec namespaces native commands and rejects recursive slash stubs', () => {
  const badCommands = {
    ...blueprint,
    name: 'TOEFL Speaking Coach',
    commands: [
      {
        name: 'diagnose',
        description: 'Run a TOEFL speaking diagnosis.',
        template: '/diagnose --audio $DATA_PATH',
      },
      {
        name: 'toefl-drill',
        description: 'Run a targeted TOEFL speaking drill.',
        template: 'Create a drill from $ARGUMENTS and return evidence plus next action.',
      },
    ],
  };
  const parsed = parseBlueprintText(JSON.stringify(badCommands));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  assert.deepEqual(spec.commands?.map((command) => command.name), ['toefl-diagnose', 'toefl-drill']);
  const diagnose = spec.commands?.[0];
  assert.ok(diagnose);
  assert.doesNotMatch(diagnose.template, /^\/diagnose\b/);
  assert.doesNotMatch(diagnose.template, /\$DATA_PATH/);
  assert.match(diagnose.template, /\$ARGUMENTS/);
  assert.match(diagnose.template, /TOEFL speaking diagnosis/i);
  assert.match(diagnose.template, /score/i);
  assert.match(diagnose.template, /evidence/i);
});

test('parseBlueprintText synthesizes eval cases when the model omits that non-core field', () => {
  const { evalCases: _evalCases, ...withoutEvalCases } = blueprint;
  const parsed = parseBlueprintText(JSON.stringify(withoutEvalCases));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.ok(parsed.value.evalCases.length >= 1);
  const spec = blueprintToSpec(parsed.value);
  assert.match(spec.persona, /Eval cases/);
  assert.match(spec.persona, /score|evidence|error taxonomy|drill/i);
  assert.equal(spec.evals?.[0]?.name, 'eval-1');
});

test('blueprintToSpec compiles native score scales into rubric prompts and validators', async () => {
  const scaled = {
    ...blueprint,
    rubrics: [
      {
        ...blueprint.rubrics[0],
        scoreScale: { label: 'band', min: 1, max: 6, increment: 0.5 },
      },
    ],
  };
  const parsed = parseBlueprintText(JSON.stringify(scaled));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  const rubric = spec.rubrics[0]!;
  assert.match(rubric.prompt, /Score scale: band 1-6/i);

  assert.equal(await runValidator(rubric.validator, 'score evidence error taxonomy drill band 6 band 5.5'), 0);
  assert.notEqual(await runValidator(rubric.validator, 'score evidence error taxonomy drill band 7'), 0);
});

test('blueprintToSpec treats pipe-separated score labels as alternatives, not a literal label', async () => {
  const scaled = {
    ...blueprint,
    rubrics: [
      {
        ...blueprint.rubrics[0],
        scoreScale: { label: 'band|score', min: 0, max: 4, increment: 1 },
      },
    ],
  };
  const parsed = parseBlueprintText(JSON.stringify(scaled));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const rubric = blueprintToSpec(parsed.value).rubrics[0]!;
  assert.equal(await runValidator(rubric.validator, 'score evidence error taxonomy drill score 4'), 0);
  assert.equal(await runValidator(rubric.validator, 'score evidence error taxonomy drill band 3'), 0);
  assert.notEqual(await runValidator(rubric.validator, 'score evidence error taxonomy drill score 5'), 0);
});

test('blueprintToSpec normalizes native tool declarations to the real Vegito tool surface', () => {
  const tooly = {
    ...blueprint,
    toolGrants: ['fs.read', 'asr', 'rubric_evaluator', 'fetch'],
    roles: [
      {
        ...blueprint.roles[0],
        tools: ['fs.read', 'asr', 'rubric_evaluator', 'fetch'],
      },
    ],
  };
  const parsed = parseBlueprintText(JSON.stringify(tooly));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  assert.deepEqual(spec.grants, ['read', 'fetch', 'memory']);
  assert.deepEqual(spec.agents[0]?.tools, ['read', 'fetch']);
});

test('blueprintToSpec infers practical local-analysis grants for data-science harnesses', () => {
  const dataScience = {
    ...blueprint,
    name: 'customer-churn-analysis-harness',
    description: 'A customer churn data science analysis harness.',
    targetUser: 'A data science team.',
    jobToBeDone: 'Analyze a local churn dataset and produce reproducible artifacts.',
    taskTaxonomy: ['schema inspection', 'data quality checks', 'EDA', 'artifact outputs', 'reproducibility verification'],
    roles: [
      {
        name: 'schema-inspector',
        tier: 'fast',
        tools: [],
        mission: 'Inspect local dataset schema.',
        workflow: ['find dataset', 'read schema', 'flag risks'],
        outputContract: ['Report schema and assumptions.'],
      },
      {
        name: 'eda-analyst',
        tier: 'smart',
        tools: [],
        mission: 'Run local descriptive analysis.',
        workflow: ['read data', 'run checks', 'write artifacts'],
        outputContract: ['Every claim cites data evidence.'],
      },
      {
        name: 'causal-guard',
        tier: 'smart',
        tools: [],
        mission: 'Review analysis text for unsupported causal claims.',
        workflow: ['read report', 'rewrite claims'],
        outputContract: ['Causal approval or rejection is explicit.'],
      },
    ],
    toolGrants: [],
    dataQualityGates: ['Check missingness and duplicate rows before EDA.'],
    artifactOutputs: [
      {
        name: 'analysis-report',
        path: 'artifacts/report.md',
        description: 'A reproducible churn analysis report.',
        requiredSignals: ['schema', 'quality_pass', 'eda_complete'],
      },
    ],
    verificationPath: {
      steps: ['Re-run analysis from raw data.'],
      successCriteria: ['artifact paths present'],
    },
  };
  const parsed = parseBlueprintText(JSON.stringify(dataScience));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  assert.deepEqual([...spec.grants].sort(), ['bash', 'glob', 'ls', 'memory', 'read', 'write']);
  assert.deepEqual([...(spec.agents.find((agent) => agent.name === 'schema-inspector')?.tools ?? [])].sort(), ['glob', 'ls', 'read']);
  assert.deepEqual([...(spec.agents.find((agent) => agent.name === 'eda-analyst')?.tools ?? [])].sort(), ['bash', 'read', 'write']);
  assert.deepEqual([...(spec.agents.find((agent) => agent.name === 'causal-guard')?.tools ?? [])].sort(), ['read', 'write']);
});

test('blueprintToSpec keeps model tiers abstract even if native output names vendors', () => {
  const vendorTiers = {
    ...blueprint,
    tiers: {
      smart: 'Use GPT-4o or Claude Opus for difficult judgments.',
      fast: 'Use DeepSeek v4 flash for routing.',
      specialist: 'Gemini-style long-context analyst.',
    },
  };
  const parsed = parseBlueprintText(JSON.stringify(vendorTiers));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  const tierText = JSON.stringify(spec.tiers);
  assert.doesNotMatch(tierText, /gpt|claude|deepseek|gemini|openai|anthropic/i);
  assert.match(spec.tiers['smart'] ?? '', /reasoning tier/i);
  assert.match(spec.tiers['fast'] ?? '', /quick tier/i);
  assert.match(spec.tiers['specialist'] ?? '', /abstract specialist tier/i);
});

test('blueprintToSpec activates data-science artifact outputs and verification path', async () => {
  const dataScience = {
    ...blueprint,
    name: 'native-data-science-team',
    description: 'A native generated data-science analysis harness.',
    targetUser: 'An analyst who needs a trustworthy first pass on a dataset.',
    jobToBeDone: 'Turn raw data into evidence-backed findings with reproducible artifacts.',
    taskTaxonomy: ['data intake', 'schema and data quality checks', 'EDA', 'causal caution', 'artifact delivery'],
    rubrics: [
      {
        name: 'analysis-completeness',
        prompt: 'Check schema, data quality, EDA, evidence, causal caution, artifacts, and reproducibility.',
        requiredSignals: ['schema', 'data quality', 'eda', 'evidence', 'causal', 'artifact', 'reproducibility'],
      },
    ],
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
  };
  const parsed = parseBlueprintText(JSON.stringify(dataScience));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const spec = blueprintToSpec(parsed.value);
  const activeText = [
    spec.persona,
    spec.onboarding,
    ...spec.agents.map((a) => a.prompt),
    ...spec.rubrics.map((r) => r.prompt),
    ...(spec.evals ?? []).map((e) => `${e.prompt}\n${e.requiredSignals.join('\n')}`),
  ].join('\n');

  assert.match(activeText, /Data quality gates/i);
  assert.match(activeText, /Artifact outputs/i);
  assert.match(activeText, /data-quality-report/i);
  assert.match(activeText, /artifacts\/data-quality\.md/i);
  assert.match(activeText, /Verification path/i);
  assert.match(activeText, /Restart kernel and run all cells/i);

  const validator = spec.rubrics[0]!.validator;
  assert.equal(
    await runValidator(
      validator,
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
    await runValidator(validator, 'schema data quality eda evidence causal artifact reproducibility clean run'),
    0,
  );
});

test('parseBlueprintText rejects unsafe artifact paths and empty verification paths', () => {
  const dataScience = {
    ...blueprint,
    artifactOutputs: [
      {
        name: 'unsafe-report',
        path: '..\\secrets.md',
        description: 'Unsafe path.',
        requiredSignals: ['schema'],
      },
    ],
    verificationPath: {
      steps: ['Restart kernel.'],
      successCriteria: ['artifact paths present'],
    },
  };
  const unsafe = parseBlueprintText(JSON.stringify(dataScience));
  assert.equal(unsafe.ok, false);
  if (unsafe.ok) return;
  assert.match(unsafe.reason, /artifactOutputs/);

  const emptyVerification = parseBlueprintText(
    JSON.stringify({
      ...blueprint,
      verificationPath: { steps: [], successCriteria: [] },
    }),
  );
  assert.equal(emptyVerification.ok, false);
  if (emptyVerification.ok) return;
  assert.match(emptyVerification.reason, /verificationPath/);
});

test('forgeNativeSpec sends a template-isolated request without loading IELTS exemplars', async () => {
  const calls: NeutralRequest[] = [];
  const callModel = async function* (req: NeutralRequest): AsyncGenerator<ProviderEvent> {
    calls.push(req);
    yield { t: 'msg_start', model: 'scripted-native' };
    yield { t: 'text_delta', text: JSON.stringify(blueprint) };
    yield { t: 'msg_end', stop: 'end_turn', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } };
  };

  await forgeNativeSpec({
    domain: 'TOEFL speaking coach',
    callModel,
    signal: new AbortController().signal,
    model: 'scripted-native',
  });

  assert.equal(calls.length, 1);
  const req = calls[0]!;
  const promptText = [
    ...req.system,
    ...req.messages.flatMap((msg) => msg.blocks.map((block) => (block.kind === 'text' ? block.text : ''))),
  ].join('\n');
  assert.equal(req.reasoning, 'max');
  assert.match(promptText, /Do not copy from local exemplar packs, archetype templates, or existing domain examples/i);
  assert.match(promptText, /Domain\/request: TOEFL speaking coach/);
  assert.match(promptText, /"scoreScale":\{"label":"score"/);
  assert.doesNotMatch(promptText, /"scoreScale":\{"label":"band"/);
  assert.match(promptText, /tiers are abstract/i);
  assert.doesNotMatch(promptText, /packs\/ielts/i);
  assert.doesNotMatch(promptText, /ielts-claude-skills/i);
  assert.doesNotMatch(promptText, /tutor-team/i);
  assert.doesNotMatch(promptText, /IELTS writing private tutor/i);
});

test('forgeNativeSpec uses the user domain as the command namespace when the model returns a generic name', async () => {
  const genericNamedBlueprint = {
    ...blueprint,
    name: 'native-speaking-harness',
    commands: [
      {
        name: 'baseline',
        description: 'Run the baseline speaking workflow.',
        template: 'Run baseline mode on $ARGUMENTS, then return score, evidence, error taxonomy, and drill.',
      },
    ],
  };
  const callModel = async function* (): AsyncGenerator<ProviderEvent> {
    yield { t: 'msg_start', model: 'scripted-native' };
    yield { t: 'text_delta', text: JSON.stringify(genericNamedBlueprint) };
    yield { t: 'msg_end', stop: 'end_turn', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } };
  };

  const spec = await forgeNativeSpec({
    domain: 'TOEFL speaking coach',
    callModel,
    signal: new AbortController().signal,
    model: 'scripted-native',
  });

  assert.equal(spec.commands?.[0]?.name, 'toefl-baseline');
});
