import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, buildCallModel, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { importGepaCandidate } from '../../src/evolve/gepa.ts';
import type { CandidateBundle, CandidateEvalReport, EvalCase } from '../../src/evolve/types.ts';

function ports(extra: Partial<DispatchPorts> & { homeDir: string; cwd: string }): DispatchPorts {
  return {
    write: () => {},
    writeErr: () => {},
    signal: new AbortController().signal,
    ...extra,
  };
}

async function snapshot(root: string, sub = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of (await readdir(join(root, sub))).sort()) {
    if (sub === '' && name === '.evolve') continue;
    const rel = sub === '' ? name : `${sub}/${name}`;
    const st = await stat(join(root, rel));
    if (st.isDirectory()) {
      for (const [k, v] of await snapshot(root, rel)) out.set(k, v);
    } else {
      out.set(rel, await readFile(join(root, rel), 'utf8'));
    }
  }
  return out;
}

async function runEval(
  root: string,
  home: string,
  candidate: CandidateBundle,
  cases: readonly EvalCase[],
  opts: { readonly apply?: boolean } = {},
): Promise<CandidateEvalReport> {
  const candidateFile = join(home, `${candidate.candidateId}.candidate.json`);
  const casesFile = join(home, `${candidate.candidateId}.cases.json`);
  const reportFile = join(home, `${candidate.candidateId}.report.json`);
  await writeFile(candidateFile, JSON.stringify(candidate), 'utf8');
  await writeFile(casesFile, JSON.stringify(cases), 'utf8');
  const code = await dispatch(
    [
      'evolve',
      'eval',
      root,
      '--candidate',
      candidateFile,
      '--eval-cases',
      casesFile,
      '--report',
      reportFile,
      ...(opts.apply === true ? ['--apply'] : []),
    ],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(code, 0);
  return JSON.parse(await readFile(reportFile, 'utf8')) as CandidateEvalReport;
}

function ieltsCandidate(id: string): CandidateBundle {
  return {
    schema: 1,
    candidateId: id,
    harnessId: 'ielts-tutor',
    harnessDomain: 'education.language.ielts',
    parentPackVersion: '1.0.0',
    proposer: { kind: 'skillopt_style', version: 'fixture' },
    diagnosis: {
      failureLayer: 'rubric',
      userGoal: 'improve IELTS writing feedback usefulness',
      evidenceIds: [`${id}-trace`],
      summary: 'feedback lacks direct next action',
    },
    atomicEdits: [
      {
        editId: 'E1',
        target: 'persona.md',
        operation: 'add',
        bounded: true,
        text: '\n## IELTS feedback\n\n- Give band score, top reason, and next action.\n',
        diagnosis: 'make feedback actionable',
        prediction: { metric: 'verified_success', deltaMin: 0.08 },
        risks: ['rubric_drift'],
        activationPath: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
    ],
    requiredEvalSuites: ['holdout', 'safety', 'activation'],
  };
}

function holdoutCase(
  id: string,
  harnessId: string,
  editId: string,
  candidate: { readonly success: number; readonly safety?: number; readonly illegal?: number; readonly cost?: number; readonly latency?: number },
): EvalCase {
  return {
    id,
    harnessId,
    suite: 'holdout',
    baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
    candidate: {
      verifiedSuccess: candidate.success,
      permissionSafety: candidate.safety ?? 1,
      illegalActionRate: candidate.illegal ?? 0,
      cost: candidate.cost ?? 104,
      latencyMs: candidate.latency ?? 1040,
      activatedEdits: [editId],
      benefitedEdits: [editId],
    },
  };
}

function unactivatedCase(id: string, harnessId: string): EvalCase {
  return {
    id,
    harnessId,
    suite: 'holdout',
    baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
    candidate: { verifiedSuccess: 0.7, permissionSafety: 1, illegalActionRate: 0, cost: 101, latencyMs: 1010 },
  };
}

function gepaDataCandidate(id: string, operation: 'add' | 'replace' = 'add', textSuffix = 'and report assumptions'): CandidateBundle {
  return importGepaCandidate({
    candidate_id: id,
    harness_id: 'data-analysis-team',
    harness_domain: 'analytics.data_science',
    parent_pack_version: '1.0.0',
    gepa_run_id: `${id}-run`,
    model: 'deepseek-v4-pro',
    pareto: { frontier_rank: 0, dominated: false, objectives: { verified_success: 0.82, cost_delta: 0.04 } },
    diagnosis: {
      failure_layer: 'skill',
      user_goal: 'improve dataframe cleaning workflow',
      evidence_ids: [`${id}-trace`],
      summary: 'GEPA candidate proposes dataframe cleaning guidance',
    },
    edits: [
      {
        edit_id: 'E1',
        target: 'persona.md',
        operation,
        text: `\n## Data cleaning\n\n- Profile missing values before transformations ${textSuffix}.\n`,
        prediction: { metric: 'verified_success', delta_min: 0.1 },
        risks: ['token_cost'],
        activation_path: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
    ],
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
        messages: [{ role: 'user', blocks: [{ kind: 'text', text: 'trendline probe' }] }],
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

test('post-GEPA E2E trendline covers generated-harness promotion, rejection, repeat blocking, and rollback', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-e2e-trendline-'));
  const ieltsPack = join(home, 'ielts-tutor');
  const dataPack = join(home, 'data-team');
  await dispatch(
    ['forge', '--offline', '--archetype', 'tutor-team', '--domain', 'IELTS writing private tutor', '--out', ieltsPack],
    ports({ homeDir: home, cwd: home }),
  );
  await dispatch(
    ['forge', '--offline', '--archetype', 'content-studio', '--domain', 'data analysis team', '--out', dataPack],
    ports({ homeDir: home, cwd: home }),
  );

  const ieltsBefore = await snapshot(ieltsPack);
  const ieltsReport = await runEval(ieltsPack, home, ieltsCandidate('ielts-bounded-001'), [
    holdoutCase('ielts-holdout', 'ielts-tutor', 'E1', { success: 0.7 }),
  ], { apply: true });
  assert.equal(ieltsReport.decision.verdict, 'accepted');
  assert.match(await readFile(join(ieltsPack, 'persona.md'), 'utf8'), /Give band score/);
  const revertCode = await dispatch(['evolve', 'revert', ieltsPack], ports({ homeDir: home, cwd: home }));
  assert.equal(revertCode, 0);
  const rollbackByteIdentical = JSON.stringify([...ieltsBefore]) === JSON.stringify([...(await snapshot(ieltsPack))]);
  assert.equal(rollbackByteIdentical, true);

  const unsafeGepa = gepaDataCandidate('data-gepa-unsafe');
  const unsafeReport = await runEval(dataPack, home, unsafeGepa, [
    holdoutCase('data-unsafe-holdout', 'data-analysis-team', 'E1', { success: 0.9, safety: 0, illegal: 1 }),
  ]);
  assert.equal(unsafeReport.research.retainedOnParetoFrontier, true);
  assert.equal(unsafeReport.decision.verdict, 'rejected');

  const repeatedReport = await runEval(dataPack, home, unsafeGepa, [
    holdoutCase('data-repeat-holdout', 'data-analysis-team', 'E1', { success: 0.9 }),
  ]);
  assert.equal(repeatedReport.decision.verdict, 'rejected');
  assert.match(repeatedReport.decision.reasons.join('\n'), /repeats a rejected edit fingerprint/);

  const safeGepa = gepaDataCandidate('data-gepa-normalized', 'add', 'then choose an explicit imputation or deletion policy');
  const safeReport = await runEval(dataPack, home, safeGepa, [
    holdoutCase('data-safe-holdout', 'data-analysis-team', 'E1', { success: 0.82 }),
  ], { apply: true });
  assert.equal(safeReport.decision.verdict, 'accepted');
  assert.match(await readFile(join(dataPack, '.evolve/provenance.jsonl'), 'utf8'), /data-gepa-normalized:E1/);

  const unactivatedReport = await runEval(dataPack, home, gepaDataCandidate('data-gepa-unactivated'), [
    unactivatedCase('data-unactivated-holdout', 'data-analysis-team'),
  ]);
  assert.equal(unactivatedReport.decision.verdict, 'rejected');
  assert.match(unactivatedReport.decision.reasons.join('\n'), /activation evidence is incomplete/);

  const crossHarnessReport = await runEval(dataPack, home, gepaDataCandidate('data-gepa-cross-harness'), [
    holdoutCase('wrong-harness-holdout', 'ielts-tutor', 'E1', { success: 0.9 }),
  ]);
  assert.equal(crossHarnessReport.decision.verdict, 'rejected');
  assert.match(crossHarnessReport.decision.reasons.join('\n'), /cross-harness/);

  const modelProbe = await deepSeekMaxProbe();
  const reports = [ieltsReport, unsafeReport, repeatedReport, safeReport, unactivatedReport, crossHarnessReport];
  const trendline = {
    provider: modelProbe.provider,
    model: modelProbe.model,
    reasoningEffort: modelProbe.reasoningEffort,
    candidateCount: reports.length,
    holdoutDeltas: reports.map((report) => report.metrics.holdoutDelta),
    guardRegressionCount: reports.reduce((sum, report) => sum + report.metrics.guardRegressionCount, 0),
    rejectedEditRepeatRate: reports.filter((report) => report.decision.reasons.some((reason) => /repeats a rejected/i.test(reason))).length / reports.length,
    activationRate: reports.reduce((sum, report) => sum + report.metrics.activationRate, 0) / reports.length,
    benefitRate: reports.reduce((sum, report) => sum + report.metrics.benefitRate, 0) / reports.length,
    costLatencyDeltas: reports.map((report) => ({
      cost: report.metrics.costDeltaRatio,
      latency: report.metrics.latencyDeltaRatio,
    })),
    revertSuccessRate: rollbackByteIdentical ? 1 : 0,
    safetyFailureCount: reports.filter((report) => report.metrics.guardRegressionCount > 0).length,
    scenarios: [
      'generated IELTS tutor bounded improvement promoted',
      'generated data-analysis GEPA Pareto retained but rejected without gate approval',
      'normalized GEPA candidate passes full gate',
      'safety-regressing candidate rejected',
      'unactivated artifact not fully promoted',
      'rejected edit not repeated',
      'cross-harness promotion rejected without target-specific eval',
      'rollback byte-identical',
    ],
    deepSeekProbe: {
      url: modelProbe.url,
      thinkingBudget: modelProbe.thinkingBudget,
    },
  };
  const trendlineReportFile = join(home, 'post-gepa-trendline.report.json');
  await writeFile(trendlineReportFile, `${JSON.stringify(trendline, null, 2)}\n`, 'utf8');
  const persistedTrendline = JSON.parse(await readFile(trendlineReportFile, 'utf8')) as typeof trendline;

  assert.equal(persistedTrendline.provider, 'anthropic');
  assert.equal(persistedTrendline.model, 'deepseek-v4-pro');
  assert.equal(persistedTrendline.reasoningEffort, 'max');
  assert.equal(persistedTrendline.deepSeekProbe.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(persistedTrendline.deepSeekProbe.thinkingBudget, 65536);
  assert.equal(persistedTrendline.candidateCount, 6);
  assert.ok(persistedTrendline.holdoutDeltas.every((delta) => Number.isFinite(delta)));
  assert.equal(persistedTrendline.guardRegressionCount, 1);
  assert.ok(persistedTrendline.rejectedEditRepeatRate > 0);
  assert.ok(persistedTrendline.activationRate > 0);
  assert.ok(persistedTrendline.benefitRate > 0);
  assert.equal(persistedTrendline.revertSuccessRate, 1);
  assert.equal(persistedTrendline.safetyFailureCount, 1);
  assert.equal(persistedTrendline.scenarios.length, 8);
});
