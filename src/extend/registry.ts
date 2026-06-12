// P8 unified registry (DESIGN §8): "one registry" for every extension kind.
// It owns the ToolRegistry and accumulates skill roots, command roots, and
// hook specs from both user config and installed packs, presenting a single
// merged view. Skills also surface as commands (the skills-are-commands
// bridge). installPack is the meta-harness seam: a validated LoadedPack folds
// its contributions in, and its hooks.json commands are re-validated to stay
// inside the pack root — loadPack guards the manifest paths, this guards the
// hook command paths, so no pack file can point the runtime outside the pack.

import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { ToolRegistry } from '../tools/registry.ts';
import type { SkillSource } from '../tools/builtin/skill.ts';
import { discoverSkills, discoverSkillBodies } from './skills.ts';
import { discoverCommands, mergeCommandSources, commandsFrom, type CommandSource } from './commands.ts';
import { HOOK_EVENTS, type HookEvent, type HookSpec } from './hooks.ts';
import { validatePackPath, type LoadedPack } from './packs.ts';

export interface ExtensionRegistry {
  readonly tools: ToolRegistry;
  addSkillRoot(dir: string): void;
  addCommandRoot(dir: string): void;
  addHook(spec: HookSpec): void;
  installPack(pack: LoadedPack): Promise<void>;
  skills(): SkillSource;
  commands(): CommandSource;
  hookSpecs(): readonly HookSpec[];
  grants(): ReadonlySet<string>;
}

function isHookEvent(v: unknown): v is HookEvent {
  return typeof v === 'string' && (HOOK_EVENTS as readonly string[]).includes(v);
}

export function createExtensionRegistry(): ExtensionRegistry {
  const tools = new ToolRegistry();
  const skillRoots: string[] = [];
  const commandRoots: string[] = [];
  const hooks: HookSpec[] = [];
  const grants = new Set<string>();

  const skillsSource = (): SkillSource => discoverSkills(skillRoots);

  return {
    tools,
    addSkillRoot: (dir) => {
      skillRoots.push(dir);
    },
    addCommandRoot: (dir) => {
      commandRoots.push(dir);
    },
    addHook: (spec) => {
      hooks.push(spec);
    },
    installPack: async (pack: LoadedPack) => {
      if (pack.skillsDir !== undefined) skillRoots.push(pack.skillsDir);
      if (pack.commandsDir !== undefined) commandRoots.push(pack.commandsDir);
      for (const g of pack.manifest.grants) grants.add(g);

      if (pack.hooksDir !== undefined) {
        const hooksJson = join(pack.hooksDir, 'hooks.json');
        let text: string | undefined;
        try {
          text = await readFile(hooksJson, 'utf8');
        } catch {
          text = undefined; // no hooks.json → pack contributes no hooks
        }
        if (text !== undefined) {
          let entries: unknown;
          try {
            entries = JSON.parse(text);
          } catch (err) {
            throw new Error(`pack "${pack.manifest.name}" hooks.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (!Array.isArray(entries)) throw new Error(`pack "${pack.manifest.name}" hooks.json must be an array`);
          for (const raw of entries) {
            const e = raw as { event?: unknown; command?: unknown; matcher?: unknown };
            if (!isHookEvent(e.event)) throw new Error(`pack "${pack.manifest.name}" hooks.json has an unknown event: ${String(e.event)}`);
            if (typeof e.command !== 'string') throw new Error(`pack "${pack.manifest.name}" hook is missing a command`);
            if (!validatePackPath(pack.root, e.command)) {
              throw new Error(`pack "${pack.manifest.name}" hook command escapes the pack root: ${e.command}`);
            }
            const command = join(pack.hooksDir, e.command.replace(/^\.\//, '').split('/').join(sep));
            const spec: HookSpec =
              typeof e.matcher === 'string'
                ? { event: e.event, command, matcher: e.matcher }
                : { event: e.event, command };
            hooks.push(spec);
          }
        }
      }
    },
    skills: skillsSource,
    commands: () => {
      const fileCommands = discoverCommands(commandRoots);
      const skillCommands = commandsFrom(
        discoverSkillBodies(skillRoots).map((s) => ({ name: s.name, description: s.description, template: s.body })),
      );
      // File commands take precedence over the skill bridge on name collision.
      return mergeCommandSources([fileCommands, skillCommands]);
    },
    hookSpecs: () => hooks,
    grants: () => grants,
  };
}
