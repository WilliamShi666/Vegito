// Extend layer barrel (DESIGN §8): the one registry plus its constituent
// discovery and loading modules — skills, commands, hooks, packs, MCP.

export { createExtensionRegistry } from './registry.ts';
export type { ExtensionRegistry } from './registry.ts';

export { discoverSkills, discoverSkillBodies, parseSkillFrontmatter } from './skills.ts';
export type { SkillFrontmatter } from './skills.ts';

export {
  discoverCommands,
  parseCommand,
  renderTemplate,
  mergeCommandSources,
  commandsFrom,
  skillsAsCommands,
} from './commands.ts';
export type { Command, CommandSource } from './commands.ts';

export { HOOK_EVENTS, classifyExit, createHookBus, spawnHookRunner } from './hooks.ts';
export type {
  HookEvent,
  HookSpec,
  HookRunner,
  HookRunResult,
  HookOutcome,
  HookDecision,
  HookBus,
  DispatchResult,
} from './hooks.ts';

export { parseManifest, validatePackPath, loadPack, declaredPaths } from './packs.ts';
export type { PackManifest, LoadedPack, PackAgent, PackRubric, PackMemory } from './packs.ts';

export {
  validatePack,
  validateManifestSemantics,
  countNegativeConstraints,
  MAX_NEGATIVE_CONSTRAINTS,
} from './pack-validate.ts';
export type { ValidationResult } from './pack-validate.ts';

export { McpClient, encodeFrame, decodeFrames, spawnStdioTransport } from './mcp/client.ts';
export type { McpTransport } from './mcp/client.ts';
