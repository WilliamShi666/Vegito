// Archetype: a content studio. A strategist frames the brief, a writer drafts, and
// an editor tightens to a house style. Rubric enforces a readability/length floor.
// Pure: (params) → ForgeSpec.

import type { Archetype, ForgeSpec } from '../spec.ts';
import { slug } from '../spec.ts';

const TIERS = {
  smart: 'the strongest available tier, for strategy and editing judgement',
  fast: 'a quick tier for drafting and variants',
} as const;

export const contentStudio: Archetype = (params): ForgeSpec => {
  const domain = params.domain.trim() || 'content';
  const name = params.name ?? `${slug(domain)}-studio`;
  const description = params.description ?? `A content studio for ${domain}: strategize, draft, and edit.`;

  const persona = [
    `You are a content studio for ${domain}.`,
    'You start from the reader and the goal, draft in their voice, and edit until every',
    'sentence earns its place. You lead with the point, cut hedging, and keep claims',
    'concrete. You match the house style you are given and explain the edits you make.',
  ].join('\n');

  const strategist = [
    `You are the strategist for ${domain}.`,
    'Turn a request into a brief: the reader, the one takeaway, the structure, and the',
    'success measure. Keep the brief to a few lines the writer can act on directly.',
  ].join('\n');

  const writer = [
    `You are the writer for ${domain}.`,
    "Draft to the strategist's brief in the reader's voice. Lead with the takeaway,",
    'use concrete detail, and keep the structure the brief calls for.',
  ].join('\n');

  const editor = [
    `You are the editor for ${domain}.`,
    'Tighten the draft to the house style: cut filler, fix flow, and surface the point.',
    'Mark each substantive change with a one-line reason so the writer learns the pattern.',
  ].join('\n');

  const readabilityValidator = [
    '#!/usr/bin/env node',
    '// Hard check: the draft must clear a minimum substance floor (non-trivial length,',
    '// and an average sentence length within a readable band).',
    'import { readFileSync } from "node:fs";',
    'const text = (process.argv[2] ?? readFileSync(0, "utf8")).trim();',
    'const words = text.split(/\\s+/).filter(Boolean);',
    'if (words.length < 20) { console.error("draft too short to grade"); process.exit(1); }',
    'const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);',
    'const avg = words.length / Math.max(sentences.length, 1);',
    'if (avg > 40) { console.error(`avg sentence length ${avg.toFixed(1)} words is hard to read`); process.exit(1); }',
    'process.exit(0);',
  ].join('\n');

  return {
    name,
    version: '1.0.0',
    description,
    persona,
    agents: [
      { name: 'strategist', tier: 'smart', tools: [], prompt: strategist },
      { name: 'writer', tier: 'fast', tools: [], prompt: writer },
      { name: 'editor', tier: 'smart', tools: [], prompt: editor },
    ],
    rubrics: [
      {
        name: 'readable-draft',
        prompt: `Check that the ${domain} draft leads with its takeaway, stays concrete, and reads cleanly aloud.`,
        validator: readabilityValidator,
      },
    ],
    memory: {
      seeds: [
        `The studio produces ${domain}.`,
        'Capture the house voice and recurring edits so later drafts need fewer passes.',
      ],
      promotion:
        'L1 episodic: per-piece edits. L2 curated: an edit applied across many pieces becomes a style rule. L3 synthesis: settled style rules form the house guide.',
    },
    onboarding: [
      `Welcome. Tell the studio the ${domain} you need, who it is for, and the one takeaway.`,
      'Share a sample in your voice if you have one; the first piece sets the house style.',
    ].join('\n'),
    tiers: { ...TIERS },
    grants: [],
  };
};
