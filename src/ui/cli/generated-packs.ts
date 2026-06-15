import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { discoverCommands } from '../../extend/commands.ts';
import { loadPack } from '../../extend/packs.ts';

export interface GeneratedPackSummary {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly path: string;
  readonly commands: readonly string[];
}

async function loadSummary(cwd: string, entry: string): Promise<GeneratedPackSummary | undefined> {
  const root = join(cwd, 'generated', entry);
  try {
    const pack = await loadPack(root);
    const commands =
      pack.commandsDir === undefined
        ? []
        : discoverCommands([pack.commandsDir])
            .list()
            .map((command) => `/${command.name}`);
    return {
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description,
      path: relative(cwd, pack.root).split(sep).join('/'),
      commands,
    };
  } catch {
    return undefined;
  }
}

export async function listGeneratedPacks(cwd: string): Promise<readonly GeneratedPackSummary[]> {
  let entries: readonly string[];
  try {
    entries = await readdir(join(cwd, 'generated'));
  } catch {
    return [];
  }
  const summaries = await Promise.all([...entries].sort().map((entry: string) => loadSummary(cwd, entry)));
  return summaries.filter((summary): summary is GeneratedPackSummary => summary !== undefined);
}

export function renderGeneratedPacks(summaries: readonly GeneratedPackSummary[]): string {
  if (summaries.length === 0) return 'no generated harnesses found\n';
  const lines = [`generated/ contains ${summaries.length} harness${summaries.length === 1 ? '' : 'es'}:`];
  for (const [index, summary] of summaries.entries()) {
    lines.push(
      '',
      `${index + 1}. ${summary.name} v${summary.version}: ${summary.path}`,
      `   ${summary.description}`,
      `   Commands: ${summary.commands.length === 0 ? '(none)' : summary.commands.join(', ')}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
