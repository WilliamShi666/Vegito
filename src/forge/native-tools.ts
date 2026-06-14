import type { NativeBlueprint, NativeRole } from './native-blueprint.ts';

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  'fs.read': 'read',
  'file.read': 'read',
  'filesystem.read': 'read',
  'fs.write': 'write',
  'file.write': 'write',
  'filesystem.write': 'write',
  shell: 'bash',
  terminal: 'bash',
  web: 'fetch',
  http: 'fetch',
} as const;

const KNOWN_TOOLS = new Set(['agent', 'bash', 'bash_output', 'edit', 'fetch', 'glob', 'grep', 'ls', 'memory', 'read', 'skill', 'todo', 'write']);

export function toolGrantsFor(blueprint: NativeBlueprint): string[] {
  return unique([
    ...normalizeTools(blueprint.toolGrants),
    ...blueprint.roles.flatMap((role) => normalizeTools(role.tools)),
    ...inferredHarnessTools(blueprint),
  ]);
}

export function toolsForRole(role: NativeRole, blueprint: NativeBlueprint): string[] {
  return unique([...normalizeTools(role.tools), ...inferredRoleTools(role, blueprint)]);
}

function inferredHarnessTools(blueprint: NativeBlueprint): string[] {
  const tools = new Set<string>();
  if (blueprint.memoryPolicy.seeds.length > 0 || blueprint.memoryPolicy.promotion.trim() !== '') tools.add('memory');
  if (isLocalDataHarness(blueprint)) {
    for (const tool of ['read', 'write', 'bash', 'ls', 'glob', 'memory']) tools.add(tool);
  }
  return [...tools];
}

function inferredRoleTools(role: NativeRole, blueprint: NativeBlueprint): string[] {
  const tools = new Set<string>();
  const roleIntent = [role.name, role.mission].join(' ').toLowerCase();
  const roleText = [role.name, role.mission, ...role.workflow, ...role.outputContract].join(' ').toLowerCase();
  if (/\bmemory\b|remember|persist|recurring|history/.test(roleText)) tools.add('memory');
  if (!isLocalDataHarness(blueprint)) return [...tools];

  if (/schema|inspect|intake|file|dataset/.test(roleText)) {
    for (const tool of ['read', 'ls', 'glob']) tools.add(tool);
  }
  if (/causal|claim|review|approval|rewrite/.test(roleIntent)) {
    for (const tool of ['read', 'write']) tools.add(tool);
    return [...tools];
  }
  if (/quality|eda|analyst|analysis|statistics|profile|check|run/.test(roleText)) {
    for (const tool of ['read', 'bash', 'write']) tools.add(tool);
  }
  if (/artifact|compile|write|deliver/.test(roleText)) {
    for (const tool of ['read', 'write']) tools.add(tool);
  }
  if (/reproduc|verify|rerun|environment|seed/.test(roleText)) {
    for (const tool of ['read', 'bash', 'write', 'memory']) tools.add(tool);
  }
  if (tools.size === 0) tools.add('read');
  return [...tools];
}

function isLocalDataHarness(blueprint: NativeBlueprint): boolean {
  const text = [
    blueprint.name,
    blueprint.description,
    blueprint.targetUser,
    blueprint.jobToBeDone,
    ...blueprint.taskTaxonomy,
    ...blueprint.qualityGates,
    ...(blueprint.dataQualityGates ?? []),
    ...(blueprint.artifactOutputs ?? []).flatMap((artifact) => [artifact.name, artifact.description, artifact.path]),
    ...(blueprint.verificationPath?.steps ?? []),
    ...(blueprint.verificationPath?.successCriteria ?? []),
  ]
    .join(' ')
    .toLowerCase();
  const hasDataWork = /\b(dataset|data science|schema|eda|churn|data quality|reproducib|notebook|csv|parquet)\b/.test(text);
  const hasExecutableAnalysisContract =
    (blueprint.dataQualityGates?.length ?? 0) > 0 || (blueprint.artifactOutputs?.length ?? 0) > 0 || blueprint.verificationPath !== undefined;
  return hasDataWork && hasExecutableAnalysisContract;
}

function normalizeTools(tools: readonly string[]): string[] {
  return unique(tools.map((tool) => TOOL_ALIASES[tool.trim().toLowerCase()] ?? tool.trim().toLowerCase()).filter((tool) => KNOWN_TOOLS.has(tool)));
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}
