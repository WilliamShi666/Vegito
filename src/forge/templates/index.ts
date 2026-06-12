// Archetype registry. Maps a template id to its pure builder. The interview and
// the `--offline` path both resolve a name here; an unknown id is a hard error so
// a typo never silently produces an empty pack.

import type { Archetype } from '../spec.ts';
import { tutorTeam } from './tutor-team.ts';
import { reviewTeam } from './review-team.ts';
import { contentStudio } from './content-studio.ts';

export const ARCHETYPES: Readonly<Record<string, Archetype>> = Object.freeze({
  'tutor-team': tutorTeam,
  'review-team': reviewTeam,
  'content-studio': contentStudio,
});

export const ARCHETYPE_IDS: readonly string[] = Object.freeze(Object.keys(ARCHETYPES));

export function getArchetype(id: string): Archetype {
  const a = ARCHETYPES[id];
  if (a === undefined) {
    throw new Error(`unknown archetype "${id}" (known: ${ARCHETYPE_IDS.join(', ')})`);
  }
  return a;
}

export { tutorTeam } from './tutor-team.ts';
export { reviewTeam } from './review-team.ts';
export { contentStudio } from './content-studio.ts';
