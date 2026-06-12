// Archetype: a tutoring team for a skills domain (DESIGN §10 acceptance exemplar).
// Three tiered agents — an examiner that assesses, a coach that explains, a
// drill-master that generates targeted practice — plus a scoring rubric with a
// hard validator and spaced-repetition memory seeds. Pure: (params) → ForgeSpec.

import type { Archetype, ForgeSpec } from '../spec.ts';
import { slug } from '../spec.ts';

const TIERS = {
  smart: 'the strongest available reasoning tier, for assessment and feedback',
  fast: 'a quick, cheap tier for drills and bookkeeping',
} as const;

export const tutorTeam: Archetype = (params): ForgeSpec => {
  const domain = params.domain.trim() || 'a skills domain';
  const name = params.name ?? `${slug(domain)}-tutor`;
  const description = params.description ?? `A tutoring team for ${domain}: assess, coach, and drill.`;

  const persona = [
    `You are a tutoring team for ${domain}.`,
    'You meet the learner where they are, name the single highest-leverage gap,',
    'and give them one concrete next action. You assess against an explicit rubric,',
    'explain why a score was given, and turn each weakness into targeted practice.',
    'You are encouraging and specific: praise what worked, then fix what did not.',
  ].join('\n');

  const examiner = [
    `You are the examiner for ${domain}.`,
    'Score the learner against the band rubric, citing the exact evidence for each band.',
    'Return a numeric band per criterion and one sentence justifying it. Be exacting and fair.',
  ].join('\n');

  const coach = [
    `You are the coach for ${domain}.`,
    `Take the examiner's scores and translate them into plain guidance: the one habit`,
    'to change next, with a worked example the learner can imitate. Keep it to three steps.',
  ].join('\n');

  const drillMaster = [
    `You are the drill-master for ${domain}.`,
    'Generate short, targeted exercises for the weakest criterion the examiner found.',
    'Each drill has a prompt, a model answer, and the one thing it trains.',
  ].join('\n');

  const bandValidator = [
    '#!/usr/bin/env node',
    '// Hard check: the examiner output must carry a numeric band 0..9 for each criterion.',
    'import { readFileSync } from "node:fs";',
    'const text = process.argv[2] ?? readFileSync(0, "utf8");',
    'const bands = [...text.matchAll(/band\\s*[:=]?\\s*([0-9](?:\\.5)?)/gi)].map((m) => Number(m[1]));',
    'if (bands.length === 0) { console.error("no band scores found"); process.exit(1); }',
    'const bad = bands.find((b) => b < 0 || b > 9);',
    'if (bad !== undefined) { console.error(`band out of range: ${bad}`); process.exit(1); }',
    'process.exit(0);',
  ].join('\n');

  return {
    name,
    version: '1.0.0',
    description,
    persona,
    agents: [
      { name: 'examiner', tier: 'smart', tools: [], prompt: examiner },
      { name: 'coach', tier: 'smart', tools: [], prompt: coach },
      { name: 'drill-master', tier: 'fast', tools: [], prompt: drillMaster },
    ],
    rubrics: [
      {
        name: 'band-score',
        prompt: `Assess the response against the ${domain} band descriptors. For each criterion give a band 0-9 and a one-line reason.`,
        validator: bandValidator,
      },
    ],
    memory: {
      seeds: [
        `The learner is studying ${domain}.`,
        'Track recurring error types so drills can target them across sessions.',
      ],
      promotion:
        'L1 episodic: per-session errors. L2 curated: an error type seen in 3+ sessions becomes a tracked weakness. L3 synthesis: a resolved weakness becomes a mastery note.',
    },
    onboarding: [
      `Welcome. To tailor ${domain} practice, the team will ask for: your current level,`,
      'your target, and one recent attempt to assess. The first session establishes a baseline band.',
    ].join('\n'),
    tiers: { ...TIERS },
    grants: [],
  };
};
