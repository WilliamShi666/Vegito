import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { importGepaCandidate } from '../../src/evolve/gepa.ts';
import { EDIT_LEDGER, REJECTED_EDITS } from '../../src/evolve/ledger.ts';
import type { CandidateBundle, EvalCase } from '../../src/evolve/types.ts';

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
  opts: { readonly apply?: boolean; readonly reportName?: string } = {},
): Promise<{ readonly code: number; readonly output: string[]; readonly report: unknown; readonly reportFile: string }> {
  const candidateFile = join(home, `${candidate.candidateId}.candidate.json`);
  const casesFile = join(home, `${candidate.candidateId}.cases.json`);
  const reportFile = join(home, opts.reportName ?? `${candidate.candidateId}.report.json`);
  await writeFile(candidateFile, JSON.stringify(candidate), 'utf8');
  await writeFile(casesFile, JSON.stringify(cases), 'utf8');
  const output: string[] = [];
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
    ports({ homeDir: home, cwd: home, write: (text) => output.push(text) }),
  );
  return { code, output, report: JSON.parse(await readFile(reportFile, 'utf8')), reportFile };
}

function acceptedIeltsCandidate(id = 'ielts-bounded-promote'): CandidateBundle {
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
      evidenceIds: ['trace-promote'],
      summary: 'feedback lacks a concise next action',
    },
    atomicEdits: [
      {
        editId: 'E1',
        target: 'persona.md',
        operation: 'add',
        bounded: true,
        text: '\n## IELTS feedback order\n\n- Give the band score, top reason, and next action.\n',
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

const acceptedIeltsCases: readonly EvalCase[] = [
  {
    id: 'ielts-holdout-promote',
    harnessId: 'ielts-tutor',
    suite: 'holdout',
    baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
    candidate: {
      verifiedSuccess: 0.7,
      permissionSafety: 1,
      illegalActionRate: 0,
      cost: 104,
      latencyMs: 1030,
      activatedEdits: ['E1'],
      benefitedEdits: ['E1'],
    },
  },
];

test('evolve eval reads a generated-harness GEPA candidate and remains read-only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-post-gepa-eval-'));
  const out = join(home, 'data-team');
  const forgeCode = await dispatch(
    ['forge', '--offline', '--archetype', 'content-studio', '--domain', 'data analysis team', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(forgeCode, 0);
  const before = await snapshot(out);

  const candidate = importGepaCandidate({
    candidate_id: 'gepa-data-001',
    harness_id: 'data-analysis-team',
    harness_domain: 'analytics.data_science',
    parent_pack_version: '1.0.0',
    gepa_run_id: 'gepa-run-1',
    model: 'deepseek-v4-pro',
    pareto: { frontier_rank: 0, dominated: false, objectives: { verified_success: 0.9 } },
    diagnosis: {
      failure_layer: 'skill',
      user_goal: 'improve dataframe cleaning workflow',
      evidence_ids: ['trace-1'],
      summary: 'candidate improves accuracy but regresses safety',
    },
    edits: [
      {
        edit_id: 'E1',
        target: 'persona.md',
        operation: 'add',
        text: '\n## Data cleaning\n\n- Profile nulls before transformations.\n',
        prediction: { metric: 'verified_success', delta_min: 0.08 },
        activation_path: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
    ],
  });
  const cases: readonly EvalCase[] = [
    {
      id: 'holdout-data-1',
      harnessId: 'data-analysis-team',
      suite: 'holdout',
      baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
      candidate: {
        verifiedSuccess: 0.9,
        permissionSafety: 0,
        illegalActionRate: 1,
        cost: 102,
        latencyMs: 1000,
        activatedEdits: ['E1'],
        benefitedEdits: ['E1'],
      },
    },
  ];
  const candidateFile = join(home, 'candidate.json');
  const casesFile = join(home, 'cases.json');
  const reportFile = join(home, 'report.json');
  await writeFile(candidateFile, JSON.stringify(candidate), 'utf8');
  await writeFile(casesFile, JSON.stringify(cases), 'utf8');

  const output: string[] = [];
  const code = await dispatch(
    ['evolve', 'eval', out, '--candidate', candidateFile, '--eval-cases', casesFile, '--report', reportFile],
    ports({ homeDir: home, cwd: home, write: (text) => output.push(text) }),
  );
  assert.equal(code, 0);
  assert.deepEqual(await snapshot(out), before, 'evolve eval must not mutate the generated harness pack');
  assert.match(output.join(''), /gepa-data-001/);
  assert.match(output.join(''), /retainedOnParetoFrontier/);

  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(report.candidateId, 'gepa-data-001');
  assert.equal(report.harnessId, 'data-analysis-team');
  assert.equal(report.decision.verdict, 'rejected');
  assert.equal(report.research.retainedOnParetoFrontier, true);
  const rejected = await readFile(join(out, REJECTED_EDITS), 'utf8');
  assert.match(rejected, /gepa-data-001/);
});

test('evolve eval --apply promotes an accepted generated-harness candidate through provenance and rollback gate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-post-gepa-apply-'));
  const out = join(home, 'ielts-tutor');
  const forgeCode = await dispatch(
    ['forge', '--offline', '--archetype', 'tutor-team', '--domain', 'IELTS writing private tutor', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(forgeCode, 0);
  const before = await snapshot(out);

  const candidate = acceptedIeltsCandidate();
  const { code, report } = await runEval(out, home, candidate, acceptedIeltsCases, { apply: true });
  assert.equal(code, 0);
  assert.equal((report as { decision: { verdict: string } }).decision.verdict, 'accepted');

  const manifest = JSON.parse(await readFile(join(out, 'pack.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.1');
  const persona = await readFile(join(out, 'persona.md'), 'utf8');
  assert.match(persona, /Give the band score, top reason, and next action\./);

  const provenance = (await readFile(join(out, '.evolve/provenance.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(provenance.length, 1);
  const record = JSON.parse(provenance[0]!);
  assert.deepEqual(record.proposals, ['ielts-bounded-promote:E1']);
  assert.deepEqual(record.observations, ['trace-promote']);

  const ledger = await readFile(join(out, EDIT_LEDGER), 'utf8');
  assert.match(ledger, /ielts-bounded-promote/);

  const revertCode = await dispatch(['evolve', 'revert', out], ports({ homeDir: home, cwd: home }));
  assert.equal(revertCode, 0);
  assert.deepEqual(await snapshot(out), before, 'post-GEPA promotion must remain byte-identically revertible');
});

test('evolve eval --apply does not promote a rejected GEPA candidate or write accepted ledger records', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-post-gepa-reject-'));
  const out = join(home, 'data-team');
  const forgeCode = await dispatch(
    ['forge', '--offline', '--archetype', 'content-studio', '--domain', 'data analysis team', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(forgeCode, 0);
  const before = await snapshot(out);

  const candidate = importGepaCandidate({
    candidate_id: 'gepa-data-rejected-apply',
    harness_id: 'data-analysis-team',
    harness_domain: 'analytics.data_science',
    parent_pack_version: '1.0.0',
    gepa_run_id: 'gepa-run-rejected',
    model: 'deepseek-v4-pro',
    pareto: { frontier_rank: 0, dominated: false, objectives: { verified_success: 0.9 } },
    diagnosis: {
      failure_layer: 'skill',
      user_goal: 'improve dataframe cleaning workflow',
      evidence_ids: ['trace-reject'],
      summary: 'candidate improves accuracy but regresses safety',
    },
    edits: [
      {
        edit_id: 'E1',
        target: 'persona.md',
        operation: 'add',
        text: '\n## Data cleaning\n\n- Profile nulls before transformations.\n',
        prediction: { metric: 'verified_success', delta_min: 0.08 },
        activation_path: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
    ],
  });
  const cases: readonly EvalCase[] = [
    {
      id: 'holdout-data-reject',
      harnessId: 'data-analysis-team',
      suite: 'holdout',
      baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
      candidate: {
        verifiedSuccess: 0.9,
        permissionSafety: 0,
        illegalActionRate: 1,
        cost: 102,
        latencyMs: 1000,
        activatedEdits: ['E1'],
        benefitedEdits: ['E1'],
      },
    },
  ];

  const { code, report } = await runEval(out, home, candidate, cases, { apply: true });
  assert.equal(code, 0);
  assert.equal((report as { decision: { verdict: string } }).decision.verdict, 'rejected');
  assert.deepEqual(await snapshot(out), before, 'rejected GEPA candidate must not mutate the generated harness');
  await assert.rejects(() => readFile(join(out, EDIT_LEDGER), 'utf8'), /ENOENT/);
  const rejected = await readFile(join(out, REJECTED_EDITS), 'utf8');
  assert.match(rejected, /gepa-data-rejected-apply/);
});

test('evolve eval --apply promotes a normalized GEPA candidate only after the full gate passes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-post-gepa-normalized-'));
  const out = join(home, 'data-team');
  const forgeCode = await dispatch(
    ['forge', '--offline', '--archetype', 'content-studio', '--domain', 'data analysis team', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(forgeCode, 0);

  const candidate = importGepaCandidate({
    candidate_id: 'gepa-data-normalized-accepted',
    harness_id: 'data-analysis-team',
    harness_domain: 'analytics.data_science',
    parent_pack_version: '1.0.0',
    gepa_run_id: 'gepa-run-normalized',
    model: 'deepseek-v4-pro',
    pareto: { frontier_rank: 0, dominated: false, objectives: { verified_success: 0.75, cost_delta: 0.04 } },
    diagnosis: {
      failure_layer: 'skill',
      user_goal: 'improve dataframe cleaning workflow',
      evidence_ids: ['trace-gepa-pass'],
      summary: 'candidate has been normalized to a bounded append-only guidance edit',
    },
    edits: [
      {
        edit_id: 'E1',
        target: 'persona.md',
        operation: 'add',
        text: '\n## Data cleaning workflow\n\n- Profile missing values before transformation and report assumptions.\n',
        prediction: { metric: 'verified_success', delta_min: 0.09 },
        risks: ['token_cost'],
        activation_path: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
    ],
  });
  const cases: readonly EvalCase[] = [
    {
      id: 'data-holdout-pass',
      harnessId: 'data-analysis-team',
      suite: 'holdout',
      baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
      candidate: {
        verifiedSuccess: 0.75,
        permissionSafety: 1,
        illegalActionRate: 0,
        cost: 104,
        latencyMs: 1040,
        activatedEdits: ['E1'],
        benefitedEdits: ['E1'],
      },
    },
  ];

  const { code, report } = await runEval(out, home, candidate, cases, { apply: true });
  assert.equal(code, 0);
  assert.equal((report as { decision: { verdict: string } }).decision.verdict, 'accepted');
  assert.equal((report as { research: { retainedOnParetoFrontier: boolean } }).research.retainedOnParetoFrontier, true);
  const persona = await readFile(join(out, 'persona.md'), 'utf8');
  assert.match(persona, /Profile missing values before transformation/);
  const provenance = await readFile(join(out, '.evolve/provenance.jsonl'), 'utf8');
  assert.match(provenance, /gepa-data-normalized-accepted:E1/);
});

test('evolve eval --apply refuses non-add edits instead of bypassing append-only apply semantics', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-post-gepa-nonadd-'));
  const out = join(home, 'data-team');
  const forgeCode = await dispatch(
    ['forge', '--offline', '--archetype', 'content-studio', '--domain', 'data analysis team', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(forgeCode, 0);
  const before = await snapshot(out);

  const candidate = importGepaCandidate({
    candidate_id: 'gepa-data-replace-accepted-eval',
    harness_id: 'data-analysis-team',
    harness_domain: 'analytics.data_science',
    parent_pack_version: '1.0.0',
    gepa_run_id: 'gepa-run-replace',
    model: 'deepseek-v4-pro',
    pareto: { frontier_rank: 0, dominated: false, objectives: { verified_success: 0.8 } },
    diagnosis: {
      failure_layer: 'prompt',
      user_goal: 'improve dataframe cleaning workflow',
      evidence_ids: ['trace-gepa-replace'],
      summary: 'candidate needs a future replace adapter before durable promotion',
    },
    edits: [
      {
        edit_id: 'E1',
        target: 'persona.md',
        operation: 'replace',
        text: '\n## Data cleaning workflow\n\n- Replace the whole feedback policy.\n',
        prediction: { metric: 'verified_success', delta_min: 0.1 },
        activation_path: ['prompt_surface'],
        rollback: { type: 'preimage_hash', value: 'persona-preimage' },
      },
    ],
  });
  const cases: readonly EvalCase[] = [
    {
      id: 'data-holdout-replace',
      harnessId: 'data-analysis-team',
      suite: 'holdout',
      baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
      candidate: {
        verifiedSuccess: 0.8,
        permissionSafety: 1,
        illegalActionRate: 0,
        cost: 102,
        latencyMs: 1020,
        activatedEdits: ['E1'],
        benefitedEdits: ['E1'],
      },
    },
  ];

  const candidateFile = join(home, 'replace.candidate.json');
  const casesFile = join(home, 'replace.cases.json');
  const reportFile = join(home, 'replace.report.json');
  await writeFile(candidateFile, JSON.stringify(candidate), 'utf8');
  await writeFile(casesFile, JSON.stringify(cases), 'utf8');
  const err: string[] = [];
  const code = await dispatch(
    ['evolve', 'eval', out, '--candidate', candidateFile, '--eval-cases', casesFile, '--report', reportFile, '--apply'],
    ports({ homeDir: home, cwd: home, writeErr: (text) => err.push(text) }),
  );
  assert.equal(code, 1);
  assert.match(err.join(''), /add-only append edits/);
  assert.deepEqual(await snapshot(out), before, 'unsupported edit operation must not mutate the generated harness');
  const report = JSON.parse(await readFile(reportFile, 'utf8'));
  assert.equal(report.decision.verdict, 'accepted', 'eval report is still persisted even when durable promotion is unavailable');
  await assert.rejects(() => readFile(join(out, EDIT_LEDGER), 'utf8'), /ENOENT/);
});

test('evolve eval rejects malformed eval cases at the CLI boundary before writing reports or ledgers', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-post-gepa-bad-cases-'));
  const out = join(home, 'ielts-tutor');
  const forgeCode = await dispatch(
    ['forge', '--offline', '--archetype', 'tutor-team', '--domain', 'IELTS writing private tutor', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(forgeCode, 0);
  const before = await snapshot(out);
  const candidate = acceptedIeltsCandidate('ielts-bad-cases');
  const candidateFile = join(home, 'candidate.json');
  const casesFile = join(home, 'cases.json');
  const reportFile = join(home, 'report.json');
  await writeFile(candidateFile, JSON.stringify(candidate), 'utf8');
  await writeFile(
    casesFile,
    JSON.stringify([
      {
        id: 'bad-case',
        harnessId: 'ielts-tutor',
        suite: 'holdout',
        baseline: { verifiedSuccess: 0.5, permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
        candidate: { verifiedSuccess: 'high', permissionSafety: 1, illegalActionRate: 0, cost: 100, latencyMs: 1000 },
      },
    ]),
    'utf8',
  );
  const err: string[] = [];
  const code = await dispatch(
    ['evolve', 'eval', out, '--candidate', candidateFile, '--eval-cases', casesFile, '--report', reportFile, '--apply'],
    ports({ homeDir: home, cwd: home, writeErr: (text) => err.push(text) }),
  );
  assert.equal(code, 1);
  assert.match(err.join(''), /invalid evolve eval case/i);
  assert.deepEqual(await snapshot(out), before);
  await assert.rejects(() => readFile(reportFile, 'utf8'), /ENOENT/);
  await assert.rejects(() => readFile(join(out, EDIT_LEDGER), 'utf8'), /ENOENT/);
  await assert.rejects(() => readFile(join(out, REJECTED_EDITS), 'utf8'), /ENOENT/);
});
