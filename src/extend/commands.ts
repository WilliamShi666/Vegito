// P8 commands (DESIGN §8): "skills are commands". A command is a prompt
// template invocable by user or model. Disk commands are *.md files whose
// optional frontmatter carries a description and whose body is the template;
// skills surface as commands whose template is the skill body. render()
// expands $ARGUMENTS (the whole argument string) and $1..$9 (whitespace-split
// positionals); unknown placeholders are left untouched so a template can talk
// about literal "$X" safely.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillSource } from '../tools/builtin/skill.ts';

export interface Command {
  readonly name: string;
  readonly description: string;
  readonly template: string;
}

export interface CommandSource {
  list(): readonly Command[];
  /** Render the named command with a raw argument string, or undefined if unknown. */
  render(name: string, args: string): string | undefined;
}

const FRONT_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseCommand(name: string, text: string): Command {
  const m = FRONT_RE.exec(text);
  if (!m) return { name, description: '', template: text };
  const front = m[1] ?? '';
  const template = m[2] ?? '';
  let description = '';
  for (const line of front.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    if (line.slice(0, idx).trim() === 'description') description = line.slice(idx + 1).trim();
  }
  return { name, description, template };
}

export function renderTemplate(template: string, args: string): string {
  const positional = args.trim() === '' ? [] : args.trim().split(/\s+/);
  // $ARGUMENTS first (longest token), then $1..$9. Replace via callback so a
  // literal value containing "$2" is never re-expanded.
  return template
    .replaceAll('$ARGUMENTS', args)
    .replace(/\$([1-9])/g, (whole, d: string) => positional[Number(d) - 1] ?? whole);
}

function makeSource(commands: readonly Command[]): CommandSource {
  const byName = new Map<string, Command>();
  for (const c of commands) if (!byName.has(c.name)) byName.set(c.name, c);
  const list = [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    list: () => list,
    render: (name, args) => {
      const cmd = byName.get(name);
      return cmd ? renderTemplate(cmd.template, args) : undefined;
    },
  };
}

function readDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function discoverCommands(roots: readonly string[]): CommandSource {
  const found: Command[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const file of readDirNames(root)) {
      if (!file.endsWith('.md')) continue;
      const name = file.slice(0, -'.md'.length);
      if (seen.has(name)) continue;
      const path = join(root, file);
      try {
        if (!statSync(path).isFile()) continue;
        found.push(parseCommand(name, readFileSync(path, 'utf8')));
        seen.add(name);
      } catch {
        continue;
      }
    }
  }
  return makeSource(found);
}

export async function skillsAsCommands(skills: SkillSource): Promise<CommandSource> {
  const commands: Command[] = [];
  for (const meta of skills.list()) {
    const body = await skills.load(meta.name);
    if (body === undefined) continue;
    commands.push({ name: meta.name, description: meta.description, template: body });
  }
  return makeSource(commands);
}

export function mergeCommandSources(sources: readonly CommandSource[]): CommandSource {
  const all: Command[] = [];
  for (const s of sources) all.push(...s.list());
  return makeSource(all);
}

/** Build a CommandSource directly from materialized commands. */
export function commandsFrom(commands: readonly Command[]): CommandSource {
  return makeSource(commands);
}
