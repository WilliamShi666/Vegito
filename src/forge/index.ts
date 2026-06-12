// Forge (DESIGN §10/D14) — the meta-harness. Interview or `--from <docs>` →
// ForgeSpec → file map → a pack that passes `packs validate` and loads. The
// offline path uses archetype templates + the scripted provider so the whole
// flow is testable without an API.

export { slug } from './spec.ts';
export type {
  ForgeSpec,
  SpecAgent,
  SpecRubric,
  SpecMemory,
  Archetype,
  ArchetypeParams,
} from './spec.ts';

export { ARCHETYPES, ARCHETYPE_IDS, getArchetype, tutorTeam, reviewTeam, contentStudio } from './templates/index.ts';

export { specToFiles, writePack, generatePack } from './generate.ts';
export type { FileMap } from './generate.ts';
