// Context layer (DESIGN §6): three-tier prompt assembly, fragment diffing,
// compaction, token accounting, file-freshness, and memory-file discovery.
// The cache-stability contract (D4) lives here: T1+T2 frozen at session start,
// fragments out of the prefix, compaction the only deliberate prefix rewrite.

export * from './tokens.ts';
export * from './filestate.ts';

export { createSystemPrompt } from './prompt.ts';
export type { SystemPrompt, PromptParts, PromptEnvironment, MemoryFile } from './prompt.ts';

export { createFragmentRegistry } from './fragments.ts';
export type { Fragment, FragmentRegistry } from './fragments.ts';

export {
  findCompactBoundary,
  microCompact,
  stripScratchpad,
  renderSummaryTemplate,
  MICRO_POINTER_PREFIX,
} from './compact.ts';
export type { MicroResult, SummarySections } from './compact.ts';

export { discoverMemoryFiles, MEMORY_FILE_CAP } from './discovery.ts';
export type { DiscoveryOptions } from './discovery.ts';
