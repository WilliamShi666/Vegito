import type { SpecCommand } from './spec.ts';
import { slug } from './spec.ts';
import type { NativeBlueprint, NativeCommand } from './native-blueprint.ts';

export function commandsFor(blueprint: NativeBlueprint, namespaceHints: readonly string[] = []): readonly SpecCommand[] {
  const namespace = commandNamespace([
    ...namespaceHints,
    blueprint.name,
    blueprint.description,
    blueprint.targetUser,
    blueprint.jobToBeDone,
  ]);
  return blueprint.commands?.map((command) => commandFor(command, namespace, blueprint)) ?? [];
}

function commandFor(command: NativeCommand, namespace: string, blueprint: NativeBlueprint): SpecCommand {
  const name = namespacedCommandName(command.name, namespace);
  return {
    name,
    description: command.description,
    template: commandTemplate(command, blueprint),
  };
}

function commandNamespace(sources: readonly string[]): string {
  const tokens = sources.flatMap((source) => slug(source).split('-').filter((token) => token !== ''));
  const preferred = ['toefl', 'ielts', 'churn'].find((token) => tokens.includes(token));
  if (preferred !== undefined) return preferred;
  if (isAdmissionsNamespace(tokens)) return 'admissions';
  const generic = new Set(['native', 'generated', 'domain', 'harness', 'coach', 'team', 'analysis']);
  return tokens.find((token) => !generic.has(token)) ?? tokens[0] ?? 'pack';
}

function isAdmissionsNamespace(tokens: readonly string[]): boolean {
  const set = new Set(tokens);
  if (set.has('admissions') || set.has('admission')) return true;
  if (set.has('undergraduate') && (set.has('college') || set.has('application') || set.has('applicant'))) return true;
  return set.has('college') && (set.has('counselor') || set.has('consultant') || set.has('applicant'));
}

function namespacedCommandName(name: string, namespace: string): string {
  const base = slug(name);
  if (base === namespace || base.startsWith(`${namespace}-`)) return base;
  return `${namespace}-${base}`;
}

function commandTemplate(command: NativeCommand, blueprint: NativeBlueprint): string {
  const cleaned = supportedPlaceholdersOnly(command.template).trim();
  return startsWithSlashCommand(cleaned) ? fallbackCommandTemplate(command, blueprint) : cleaned;
}

function startsWithSlashCommand(template: string): boolean {
  return /^\/[a-z0-9][a-z0-9-]*(?:\s|$)/i.test(template.trim());
}

function supportedPlaceholdersOnly(template: string): string {
  return template.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) => (name === 'ARGUMENTS' ? whole : '$ARGUMENTS'));
}

function fallbackCommandTemplate(command: NativeCommand, blueprint: NativeBlueprint): string {
  const roleNames = blueprint.roles.map((role) => role.name);
  const rubricSignals = unique(blueprint.rubrics.flatMap((rubric) => rubric.requiredSignals));
  return [
    `Run this harness workflow: ${command.description}`,
    'Input: $ARGUMENTS',
    section('Use the most relevant roles', roleNames),
    section('Follow these quality gates', blueprint.qualityGates),
    section('Respect this evidence contract', blueprint.evidenceContract),
    section('Return required rubric signals', rubricSignals.length === 0 ? ['the declared rubric signals'] : rubricSignals),
  ].join('\n');
}

function section(title: string, items: readonly string[]): string {
  return [`${title}:`, ...items.map((item) => `- ${item}`)].join('\n');
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}
