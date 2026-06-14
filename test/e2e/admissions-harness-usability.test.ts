import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { scriptedText } from '../../src/providers/wire/scripted.ts';

async function scriptFile(steps: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vegito-admissions-script-'));
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

test('fresh native admissions harness validates and runs without manual integration edits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-admissions-e2e-'));
  const outDir = join(home, 'admissions-live');
  const blueprint = {
    schema: 1,
    name: 'college-application-agency',
    version: '1.0.0',
    description: 'A US undergraduate application counseling harness.',
    targetUser: 'A student applying to US undergraduate programs with family support.',
    jobToBeDone: 'Turn applicant context into an ethical, evidence-backed application plan.',
    taskTaxonomy: [
      'student intake and constraints',
      'school-list strategy',
      'application timeline',
      'activities and essays',
      'recommendations and materials checklist',
      'financial aid and scholarship considerations',
      'ethics and compliance boundaries',
    ],
    modes: [
      {
        name: 'profile review',
        trigger: 'The student gives profile details or asks where to start.',
        workflow: ['collect intake', 'identify constraints', 'save applicant memory', 'return next actions'],
        output: 'Applicant profile diagnosis and action plan.',
      },
      {
        name: 'school list',
        trigger: 'The student asks where to apply.',
        workflow: ['read applicant profile', 'balance reach target likely options', 'flag cost and fit risks'],
        output: 'School-list strategy with evidence and risk notes.',
      },
      {
        name: 'essay planning',
        trigger: 'The student asks about essays or activities.',
        workflow: ['extract activities', 'map themes', 'protect authenticity', 'assign drafts'],
        output: 'Essay and activities plan with ethical boundaries.',
      },
    ],
    routing: ['Start with profile review when applicant memory is missing.', 'Use school list only after intake has academic, budget, location, and preference fields.'],
    roles: [
      {
        name: 'intake-strategist',
        tier: 'fast',
        tools: ['memory'],
        mission: 'Collect applicant profile, constraints, deadlines, and missing fields.',
        workflow: ['ask for missing intake', 'save applicant memory', 'route next workflow'],
        outputContract: ['State known fields, missing fields, and next actions.'],
      },
      {
        name: 'school-list-architect',
        tier: 'smart',
        tools: ['memory'],
        mission: 'Build a balanced school-list strategy from applicant memory and explicit constraints.',
        workflow: ['read applicant memory', 'separate reach target likely schools', 'cite fit and cost rationale'],
        outputContract: ['Every school-list recommendation states evidence and uncertainty.'],
      },
      {
        name: 'essay-activities-coach',
        tier: 'smart',
        tools: ['memory'],
        mission: 'Help the student select authentic activities and essay angles without fabrication.',
        workflow: ['read activities', 'choose themes', 'assign essay tasks', 'record draft status'],
        outputContract: ['Essay advice preserves student authorship.'],
      },
      {
        name: 'compliance-guardian',
        tier: 'smart',
        tools: [],
        mission: 'Enforce ethics, privacy, and compliance boundaries for admissions counseling.',
        workflow: ['check for fabrication', 'check privacy risk', 'flag prohibited actions'],
        outputContract: ['Ethics and compliance status is explicit.'],
      },
    ],
    rubrics: [
      {
        name: 'admissions-plan-completeness',
        prompt: 'Check intake, school list, timeline, activities, essays, recommendations, materials checklist, financial aid, ethics, memory, and next actions.',
        requiredSignals: [
          'intake',
          'school list',
          'timeline',
          'activities',
          'essays',
          'recommendations',
          'materials checklist',
          'financial aid',
          'ethics',
          'memory',
          'next actions',
        ],
      },
    ],
    qualityGates: [
      'Advice must distinguish facts, assumptions, and uncertainties.',
      'Ethics/compliance boundaries must be explicit before essay or activity advice.',
      'School-list strategy must include reach, target, and likely categories.',
    ],
    evidenceContract: ['Every recommendation cites applicant-provided evidence, stated preference, deadline, budget, or uncertainty.'],
    errorTaxonomy: ['missing-intake', 'overreach-school-list', 'fabricated-essay-risk', 'deadline-risk', 'financial-aid-blindspot'],
    memoryPolicy: {
      seeds: ['Track applicant profile, target schools, deadlines, essays, recommendation status, risks, and next actions.'],
      promotion: 'Promote repeated risks and confirmed preferences into the applicant memory after each workflow.',
    },
    failurePolicy: ['Ask for missing intake before making high-confidence recommendations.', 'Refuse fabrication, impersonation, or guarantee language.'],
    approvalGates: ['Ask before storing sensitive applicant details.', 'Ask before using family financial details in financial aid planning.'],
    toolGrants: [],
    commands: [
      {
        name: 'profile-review',
        description: 'Run applicant intake, profile review, memory update, and next-action planning.',
        template: '/review-profile $PROFILE',
      },
      {
        name: 'school-list',
        description: 'Build a school-list strategy from applicant context.',
        template: 'Create an admissions school list from $ARGUMENTS with reach, target, likely, financial aid, ethics, and next actions.',
      },
      {
        name: 'essay-plan',
        description: 'Plan activities and essays with authenticity checks.',
        template: 'Plan activities and essays from $ARGUMENTS. Include recommendations, materials checklist, ethics, memory updates, and next actions.',
      },
    ],
    examples: ['Review an applicant profile and produce an ethical plan for US undergraduate applications.'],
    evalCases: ['Reject an output that gives school-list advice without intake, financial aid, ethics, memory, and next actions.'],
    tiers: { smart: 'the strongest available reasoning tier', fast: 'a quick tier for routing and bookkeeping' },
  };

  const forgeScript = await scriptFile([{ kind: 'events', events: scriptedText(JSON.stringify(blueprint)) }]);
  const forge = portsFor({ homeDir: home, cwd: home });
  const forgeCode = await dispatch(
    [
      'forge',
      '--native',
      '--domain',
      'US undergraduate admissions counselor application agency',
      '--out',
      outDir,
      '--script',
      forgeScript,
    ],
    forge.ports,
  );

  assert.equal(forgeCode, 0);
  assert.match(forge.out.join(''), /vegito repl --pack/);

  const validate = portsFor({ homeDir: home, cwd: home });
  assert.equal(await dispatch(['packs', 'validate', outDir], validate.ports), 0);
  assert.match(validate.out.join(''), /valid/);

  const commandFiles = await readdir(join(outDir, 'commands'));
  assert.deepEqual(commandFiles.sort(), ['admissions-essay-plan.md', 'admissions-profile-review.md', 'admissions-school-list.md']);
  const profileCommand = await readFile(join(outDir, 'commands', 'admissions-profile-review.md'), 'utf8');
  assert.doesNotMatch(profileCommand, /^\/review-profile/m);
  assert.doesNotMatch(profileCommand, /\$PROFILE/);
  assert.match(profileCommand, /\$ARGUMENTS/);

  const persona = await readFile(join(outDir, 'persona.md'), 'utf8');
  assert.match(persona, /school-list strategy/i);
  assert.match(persona, /financial aid and scholarship/i);
  assert.match(persona, /ethics and compliance/i);
  assert.match(persona, /recommendations and materials checklist/i);

  const replScript = await scriptFile([
    {
      kind: 'events',
      events: [
        { t: 'msg_start', model: 'scripted-1' },
        {
          t: 'tool_call',
          callId: 'a1',
          name: 'memory',
          input: {
            action: 'save',
            name: 'admissions-applicant-profile',
            content:
              'applicant profile: GPA 3.8, CS interest, budget sensitive\ntarget schools: balanced list pending\ndeadlines: November early action risk\nessays: brainstorm stage\nrecommendation status: ask math teacher\nfinancial aid: need-based aid important\nrisks: overreach school list\nnext actions: complete intake',
          },
        },
        { t: 'msg_end', stop: 'tool_use', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
    {
      kind: 'events',
      events: scriptedText(
        [
          'intake complete and memory saved',
          'school list: reach target likely categories need more evidence',
          'timeline: early action deadline risk',
          'activities and essays: select authentic CS project story',
          'recommendations: ask math teacher',
          'materials checklist: transcript, test scores, activity list, essays',
          'financial aid: need-based aid and scholarship considerations',
          'ethics: no fabrication, student authorship preserved',
          'next actions: finish intake, draft essay outline, confirm budget',
        ].join('\n'),
      ),
    },
  ]);
  const lines: (string | null)[] = ['/admissions-profile-review GPA 3.8 CS budget-sensitive early action', null];
  let index = 0;
  const run = portsFor({ homeDir: home, cwd: home, nextLine: async () => lines[index++] ?? null });

  assert.equal(await dispatch(['repl', '--pack', outDir, '--script', replScript, '--mode', 'bypass'], run.ports), 0);
  assert.match(run.out.join(''), /intake complete/);
  assert.match(await readFile(join(home, '.vegito', 'memory', 'admissions-applicant-profile.md'), 'utf8'), /financial aid/);

  const candidate = join(home, 'admissions-output.md');
  await writeFile(candidate, run.out.join(''), 'utf8');
  const outputValidation = portsFor({ homeDir: home, cwd: home });
  assert.equal(await dispatch(['packs', 'validate-output', outDir, candidate], outputValidation.ports), 0);
  assert.match(outputValidation.out.join(''), /output valid/);
});
