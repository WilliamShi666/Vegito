// Archetype: a code/document review team. A reviewer finds issues, a security
// auditor checks a threat surface, and a synthesizer turns findings into a ranked,
// actionable report. Rubric enforces that every finding carries a severity.
// Pure: (params) → ForgeSpec.

import type { Archetype, ForgeSpec } from '../spec.ts';
import { slug } from '../spec.ts';

const TIERS = {
  smart: 'the strongest available reasoning tier, for judgement-heavy review',
  fast: 'a quick tier for mechanical checks and formatting',
} as const;

export const reviewTeam: Archetype = (params): ForgeSpec => {
  const domain = params.domain.trim() || 'changes';
  const name = params.name ?? `${slug(domain)}-review`;
  const description = params.description ?? `A review team for ${domain}: critique, audit, and synthesize findings.`;

  const persona = [
    `You are a review team for ${domain}.`,
    'You read the work as a skeptical peer would: you find the real problems, rank them',
    'by impact, and say exactly where and how to fix each one. Every finding cites a',
    'location and a severity. You separate must-fix from nice-to-have, and you lead with',
    'the highest-impact issue so the author knows where to start.',
  ].join('\n');

  const reviewer = [
    `You are the reviewer for ${domain}.`,
    'Find correctness, clarity, and design issues. For each, give location, severity',
    '(blocker/major/minor), and a concrete fix. Quote the smallest span that shows the problem.',
  ].join('\n');

  const auditor = [
    `You are the security auditor for ${domain}.`,
    'Walk the threat surface: input handling, auth, secrets, injection, unsafe defaults.',
    'Report each exposure with severity and the minimal change that closes it.',
  ].join('\n');

  const synthesizer = [
    `You are the synthesizer for ${domain}.`,
    'Merge the reviewer and auditor findings, dedupe, and produce one ranked list:',
    'blockers first, then majors, then minors, each with its fix. Keep it skimmable.',
  ].join('\n');

  const severityValidator = [
    '#!/usr/bin/env node',
    '// Hard check: every finding line must carry a recognized severity tag.',
    'import { readFileSync } from "node:fs";',
    'const text = process.argv[2] ?? readFileSync(0, "utf8");',
    'const findings = text.split(/\\n/).filter((l) => /\\bfinding\\b/i.test(l));',
    'if (findings.length === 0) { console.error("no findings to grade"); process.exit(1); }',
    'const sev = /\\b(blocker|major|minor)\\b/i;',
    'const missing = findings.filter((l) => !sev.test(l));',
    'if (missing.length > 0) { console.error(`${missing.length} finding(s) lack a severity`); process.exit(1); }',
    'process.exit(0);',
  ].join('\n');

  return {
    name,
    version: '1.0.0',
    description,
    persona,
    agents: [
      { name: 'reviewer', tier: 'smart', tools: [], prompt: reviewer },
      { name: 'auditor', tier: 'smart', tools: [], prompt: auditor },
      { name: 'synthesizer', tier: 'fast', tools: [], prompt: synthesizer },
    ],
    rubrics: [
      {
        name: 'severity-tagged',
        prompt: `Check that every finding about the ${domain} carries a severity (blocker, major, or minor) and a concrete fix.`,
        validator: severityValidator,
      },
    ],
    memory: {
      seeds: [
        `Reviews target ${domain}.`,
        'Recurring issue classes should be remembered so later reviews flag them faster.',
      ],
      promotion:
        'L1 episodic: per-review findings. L2 curated: an issue class seen repeatedly becomes a standing checklist item. L3 synthesis: a checklist item the author has internalized is retired.',
    },
    onboarding: [
      `Welcome. Point the team at the ${domain} to review and state any constraints`,
      '(style guide, threat model, what is out of scope). The first pass establishes the baseline checklist.',
    ].join('\n'),
    tiers: { ...TIERS },
    grants: [],
  };
};
