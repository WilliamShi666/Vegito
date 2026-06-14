// Native Forge compiler: model-generated DomainBlueprint JSON -> ForgeSpec.
// This is deliberately not an archetype template. The code knows only the
// generic harness schema and deterministic compilation rules; all domain
// details come from the model response or user documents.

import type { CallModel } from '../ui/runtime.ts';
import type { NeutralRequest } from '../providers/types.ts';
import type { ForgeSpec, SpecAgent, SpecCommand, SpecEvalCase, SpecRubric } from './spec.ts';
import { slug } from './spec.ts';
import { commandsFor } from './native-commands.ts';
import { toolGrantsFor, toolsForRole } from './native-tools.ts';

export interface NativeMode {
  readonly name: string;
  readonly trigger: string;
  readonly workflow: readonly string[];
  readonly output: string;
}

export interface NativeRole {
  readonly name: string;
  readonly tier: string;
  readonly tools: readonly string[];
  readonly mission: string;
  readonly workflow: readonly string[];
  readonly outputContract: readonly string[];
}

export interface NativeRubric {
  readonly name: string;
  readonly prompt: string;
  readonly requiredSignals: readonly string[];
  readonly scoreScale?: NativeScoreScale;
}

export interface NativeMemoryPolicy {
  readonly seeds: readonly string[];
  readonly promotion: string;
}

export interface NativeScoreScale {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly increment?: number;
}

export interface NativeCommand {
  readonly name: string;
  readonly description: string;
  readonly template: string;
}

export interface NativeArtifactOutput {
  readonly name: string;
  readonly path: string;
  readonly description: string;
  readonly requiredSignals: readonly string[];
}

export interface NativeVerificationPath {
  readonly steps: readonly string[];
  readonly successCriteria: readonly string[];
}

export interface NativeBlueprint {
  readonly schema: 1;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly targetUser: string;
  readonly jobToBeDone: string;
  readonly taskTaxonomy: readonly string[];
  readonly modes: readonly NativeMode[];
  readonly routing: readonly string[];
  readonly roles: readonly NativeRole[];
  readonly rubrics: readonly NativeRubric[];
  readonly qualityGates: readonly string[];
  readonly evidenceContract: readonly string[];
  readonly errorTaxonomy: readonly string[];
  readonly memoryPolicy: NativeMemoryPolicy;
  readonly failurePolicy: readonly string[];
  readonly approvalGates: readonly string[];
  readonly toolGrants: readonly string[];
  readonly commands?: readonly NativeCommand[];
  readonly dataQualityGates?: readonly string[];
  readonly artifactOutputs?: readonly NativeArtifactOutput[];
  readonly verificationPath?: NativeVerificationPath;
  readonly examples: readonly string[];
  readonly evalCases: readonly string[];
  readonly tiers: Readonly<Record<string, string>>;
}

export type ParseResult = { readonly ok: true; readonly value: NativeBlueprint } | { readonly ok: false; readonly reason: string };

const DEFAULT_TIERS = {
  smart: 'the strongest available reasoning tier for judgement-heavy work',
  fast: 'a quick tier for routing, bookkeeping, and mechanical checks',
} as const;

const NATIVE_SYSTEM = [
  'You are Vegito Forge native compiler. Produce one JSON object and nothing else.',
  'Do not copy from local exemplar packs, archetype templates, or existing domain examples.',
  'Design a domain harness blueprint from the user request or documents.',
  'The JSON schema is:',
  '{',
  '  "schema": 1, "name": "lower-kebab-id", "version": "1.0.0",',
  '  "description": "one sentence", "targetUser": "...", "jobToBeDone": "...",',
  '  "taskTaxonomy": ["..."],',
  '  "modes": [{"name":"...","trigger":"...","workflow":["..."],"output":"..."}],',
  '  "routing": ["..."],',
  '  "roles": [{"name":"...","tier":"smart|fast","tools":[],"mission":"...","workflow":["..."],"outputContract":["..."]}],',
  '  "rubrics": [{"name":"...","prompt":"...","requiredSignals":["..."],"scoreScale":{"label":"score","min":1,"max":5,"increment":1}}],',
  '  "qualityGates": ["..."], "evidenceContract": ["..."], "errorTaxonomy": ["..."],',
  '  "memoryPolicy": {"seeds":["..."],"promotion":"..."},',
  '  "failurePolicy": ["..."], "approvalGates": ["..."], "toolGrants": [],',
  '  "dataQualityGates": ["..."],',
  '  "artifactOutputs": [{"name":"...","path":"artifacts/report.md","description":"...","requiredSignals":["..."]}],',
  '  "verificationPath": {"steps":["..."],"successCriteria":["..."]},',
  '  "commands": [{"name":"...","description":"...","template":"... $ARGUMENTS ..."}],',
  '  "examples": ["..."], "evalCases": ["..."],',
  '  "tiers": {"smart":"...","fast":"..."}',
  '}',
  'Use label "band" only when the user explicitly requests an exam band scale; otherwise use "score".',
  'Model tiers are abstract capability hints, never vendor or concrete model names.',
  'Command names must be namespaced by domain, such as "toefl-diagnose" or "churn-run-pipeline".',
  'Command templates must be complete workflow prompts, must not start with another slash command, and may only use $ARGUMENTS or $1..$9 placeholders.',
].join('\n');

export function parseBlueprintText(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(extractJson(text));
  } catch (err) {
    return { ok: false, reason: `blueprint is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  return parseBlueprint(raw);
}

export function blueprintToSpec(
  blueprint: NativeBlueprint,
  opts: { readonly nameOverride?: string; readonly domainHint?: string } = {},
): ForgeSpec {
  const tiers = tiersFor(blueprint);
  const grants = toolGrantsFor(blueprint);
  const agents: readonly SpecAgent[] = blueprint.roles.map((role) => ({
    name: role.name,
    tier: role.tier in tiers ? role.tier : 'smart',
    tools: toolsForRole(role, blueprint),
    prompt: rolePrompt(role, blueprint),
  }));
  const rubrics: readonly SpecRubric[] = blueprint.rubrics.map((rubric) => ({
    name: rubric.name,
    prompt: rubricPrompt(rubric, blueprint),
    validator: validatorFor(rubric, blueprint),
  }));
  const namespaceHints = [opts.domainHint, opts.nameOverride].filter((hint): hint is string => hint !== undefined);
  const commands: readonly SpecCommand[] | undefined =
    blueprint.commands === undefined ? undefined : commandsFor(blueprint, namespaceHints);
  const evals = evalCasesFor(blueprint);

  return {
    name: opts.nameOverride ?? slug(blueprint.name),
    version: blueprint.version,
    description: blueprint.description,
    persona: personaPrompt(blueprint),
    agents,
    rubrics,
    ...(commands !== undefined && commands.length > 0 ? { commands } : {}),
    ...(evals.length > 0 ? { evals } : {}),
    memory: {
      seeds: blueprint.memoryPolicy.seeds,
      promotion: blueprint.memoryPolicy.promotion,
    },
    onboarding: onboardingPrompt(blueprint),
    tiers,
    grants,
  };
}

export async function forgeNativeSpec(opts: {
  readonly domain?: string;
  readonly docs?: string;
  readonly name?: string;
  readonly callModel: CallModel;
  readonly signal: AbortSignal;
  readonly model: string;
}): Promise<ForgeSpec> {
  const req: NeutralRequest = {
    model: opts.model,
    system: [NATIVE_SYSTEM],
    messages: [
      {
        role: 'user',
        blocks: [
          {
            kind: 'text',
            text: nativeUserPrompt(opts.domain, opts.docs),
          },
        ],
      },
    ],
    tools: [],
    maxTokens: 4096,
    reasoning: 'max',
  };

  const text = await collectText(opts.callModel, req, opts.signal);
  const parsed = parseBlueprintText(text);
  if (!parsed.ok) throw new Error(parsed.reason);
  const specOpts: { nameOverride?: string; domainHint?: string } = {};
  if (opts.name !== undefined) specOpts.nameOverride = slug(opts.name);
  if (opts.domain !== undefined) specOpts.domainHint = opts.domain;
  return blueprintToSpec(parsed.value, specOpts);
}

function nativeUserPrompt(domain: string | undefined, docs: string | undefined): string {
  return [
    domain === undefined ? 'Domain/request: not provided directly' : `Domain/request: ${domain}`,
    docs === undefined ? 'Documents: none' : `Documents:\n${docs}`,
    'Build a first-version domain harness blueprint with real roles, modes, quality gates, evidence requirements, memory policy, failure policy, approval gates, commands when useful, artifact outputs and verification path when useful, and eval cases.',
  ].join('\n\n');
}

async function collectText(callModel: CallModel, req: NeutralRequest, signal: AbortSignal): Promise<string> {
  let text = '';
  for await (const ev of callModel(req, signal)) {
    if (ev.t === 'text_delta') text += ev.text;
  }
  return text.trim();
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence !== null) return fence[1] ?? '';
  return trimmed;
}

function parseBlueprint(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, reason: 'blueprint must be a JSON object' };
  if (raw['schema'] !== 1) return { ok: false, reason: 'blueprint schema must be 1' };

  const name = stringField(raw, 'name');
  const version = stringField(raw, 'version');
  const description = stringField(raw, 'description');
  const targetUser = stringField(raw, 'targetUser');
  const jobToBeDone = stringField(raw, 'jobToBeDone');
  const taskTaxonomy = stringArrayField(raw, 'taskTaxonomy');
  const modes = modeArray(raw['modes']);
  const routing = stringArrayField(raw, 'routing');
  const roles = roleArray(raw['roles']);
  const rubrics = rubricArray(raw['rubrics']);
  const qualityGates = stringArrayField(raw, 'qualityGates');
  const evidenceContract = stringArrayField(raw, 'evidenceContract');
  const errorTaxonomy = stringArrayField(raw, 'errorTaxonomy');
  const parsedMemoryPolicy = memoryPolicy(raw['memoryPolicy']);
  const failurePolicy = stringArrayField(raw, 'failurePolicy');
  const approvalGates = stringArrayField(raw, 'approvalGates');
  const toolGrants = stringArrayField(raw, 'toolGrants');
  const examples = stringArrayField(raw, 'examples');
  const parsedEvalCases = stringArrayField(raw, 'evalCases');
  const tiers = tiersField(raw['tiers']);
  const commands = commandArray(raw['commands']);
  const dataQualityGates = stringArray(raw['dataQualityGates']);
  const artifactOutputs = artifactOutputArray(raw['artifactOutputs']);
  const verificationPath = verificationPathField(raw['verificationPath']);

  if (name === undefined) return { ok: false, reason: 'blueprint is missing or has invalid name' };
  if (version === undefined) return { ok: false, reason: 'blueprint is missing or has invalid version' };
  if (description === undefined) return { ok: false, reason: 'blueprint is missing or has invalid description' };
  if (targetUser === undefined) return { ok: false, reason: 'blueprint is missing or has invalid targetUser' };
  if (jobToBeDone === undefined) return { ok: false, reason: 'blueprint is missing or has invalid jobToBeDone' };
  if (taskTaxonomy === undefined) return { ok: false, reason: 'blueprint is missing or has invalid taskTaxonomy' };
  if (modes === undefined) return { ok: false, reason: 'blueprint is missing or has invalid modes' };
  if (routing === undefined) return { ok: false, reason: 'blueprint is missing or has invalid routing' };
  if (roles === undefined) return { ok: false, reason: 'blueprint is missing or has invalid roles' };
  if (rubrics === undefined) return { ok: false, reason: 'blueprint is missing or has invalid rubrics' };
  if (qualityGates === undefined) return { ok: false, reason: 'blueprint is missing or has invalid qualityGates' };
  if (evidenceContract === undefined) return { ok: false, reason: 'blueprint is missing or has invalid evidenceContract' };
  if (errorTaxonomy === undefined) return { ok: false, reason: 'blueprint is missing or has invalid errorTaxonomy' };
  if (parsedMemoryPolicy === undefined) return { ok: false, reason: 'blueprint is missing or has invalid memoryPolicy' };
  if (failurePolicy === undefined) return { ok: false, reason: 'blueprint is missing or has invalid failurePolicy' };
  if (approvalGates === undefined) return { ok: false, reason: 'blueprint is missing or has invalid approvalGates' };
  if (toolGrants === undefined) return { ok: false, reason: 'blueprint is missing or has invalid toolGrants' };
  if (examples === undefined) return { ok: false, reason: 'blueprint is missing or has invalid examples' };
  if (parsedEvalCases === undefined && raw['evalCases'] !== undefined) {
    return { ok: false, reason: 'blueprint has invalid evalCases' };
  }
  if (tiers === undefined) return { ok: false, reason: 'blueprint is missing or has invalid tiers' };
  if (commands === undefined && raw['commands'] !== undefined) return { ok: false, reason: 'blueprint has invalid commands' };
  if (dataQualityGates === undefined && raw['dataQualityGates'] !== undefined) {
    return { ok: false, reason: 'blueprint has invalid dataQualityGates' };
  }
  if (artifactOutputs === undefined && raw['artifactOutputs'] !== undefined) {
    return { ok: false, reason: 'blueprint has invalid artifactOutputs' };
  }
  if (verificationPath === undefined && raw['verificationPath'] !== undefined) {
    return { ok: false, reason: 'blueprint has invalid verificationPath' };
  }
  if (roles.length === 0) return { ok: false, reason: 'blueprint needs at least one role' };
  if (rubrics.length === 0) return { ok: false, reason: 'blueprint needs at least one rubric' };
  const evalCases = parsedEvalCases ?? synthesizeEvalCases(rubrics, qualityGates);

  const base = {
    schema: 1 as const,
    name,
    version,
    description,
    targetUser,
    jobToBeDone,
    taskTaxonomy,
    modes,
    routing,
    roles,
    rubrics,
    qualityGates,
    evidenceContract,
    errorTaxonomy,
    memoryPolicy: parsedMemoryPolicy,
    failurePolicy,
    approvalGates,
    toolGrants,
    examples,
    evalCases,
    tiers,
  };
  const value: NativeBlueprint = {
    ...base,
    ...(commands === undefined ? {} : { commands }),
    ...(dataQualityGates === undefined ? {} : { dataQualityGates }),
    ...(artifactOutputs === undefined ? {} : { artifactOutputs }),
    ...(verificationPath === undefined ? {} : { verificationPath }),
  };
  return { ok: true, value };
}

function personaPrompt(blueprint: NativeBlueprint): string {
  return [
    `You are a native-generated domain harness for ${blueprint.description}.`,
    `Target user: ${blueprint.targetUser}`,
    `Job to be done: ${blueprint.jobToBeDone}`,
    section('Task taxonomy', blueprint.taskTaxonomy),
    modeSection(blueprint.modes),
    section('Routing', blueprint.routing),
    section('Quality gates', blueprint.qualityGates),
    ...optionalSection('Data quality gates', blueprint.dataQualityGates),
    section('Evidence contract', blueprint.evidenceContract),
    section('Error taxonomy', blueprint.errorTaxonomy),
    section('Failure policy', blueprint.failurePolicy),
    section('Approval gates', blueprint.approvalGates),
    ...optionalArtifactOutputSection(blueprint.artifactOutputs),
    ...optionalVerificationPathSection(blueprint.verificationPath),
    section('Examples', blueprint.examples),
    section('Eval cases', blueprint.evalCases),
  ].join('\n');
}

function rolePrompt(role: NativeRole, blueprint: NativeBlueprint): string {
  return [
    `You are ${role.name}.`,
    `Mission: ${role.mission}`,
    section('Workflow', role.workflow),
    section('Output contract', role.outputContract),
    section('Shared evidence contract', blueprint.evidenceContract),
    section('Shared quality gates', blueprint.qualityGates),
    ...optionalSection('Shared data quality gates', blueprint.dataQualityGates),
    ...optionalArtifactOutputSection(blueprint.artifactOutputs),
    ...optionalVerificationPathSection(blueprint.verificationPath),
  ].join('\n');
}

function rubricPrompt(rubric: NativeRubric, blueprint: NativeBlueprint): string {
  return [
    rubric.prompt,
    ...(rubric.scoreScale === undefined ? [] : [scoreScaleLine(rubric.scoreScale)]),
    section('Required signals', rubric.requiredSignals),
    section('Quality gates', blueprint.qualityGates),
    ...optionalSection('Data quality gates', blueprint.dataQualityGates),
    ...optionalArtifactOutputSection(blueprint.artifactOutputs),
    ...optionalVerificationPathSection(blueprint.verificationPath),
  ].join('\n');
}

function onboardingPrompt(blueprint: NativeBlueprint): string {
  return [
    'Onboarding:',
    `Target user: ${blueprint.targetUser}`,
    `Job to be done: ${blueprint.jobToBeDone}`,
    section('Start by collecting', blueprint.taskTaxonomy),
    section('Mode selection', blueprint.modes.map((mode) => `${mode.name}: ${mode.trigger}`)),
    section('Approval gates', blueprint.approvalGates),
    ...optionalArtifactOutputSection(blueprint.artifactOutputs),
    ...optionalVerificationPathSection(blueprint.verificationPath),
  ].join('\n');
}

function validatorFor(rubric: NativeRubric, blueprint: NativeBlueprint): string {
  const signals = JSON.stringify(rubric.requiredSignals);
  const lines = [
    '#!/usr/bin/env node',
    '// Hard check: model-generated blueprint signals compiled by Vegito, not arbitrary model code.',
    'import { readFileSync } from "node:fs";',
    'const text = (process.argv[2] ?? readFileSync(0, "utf8")).toLowerCase();',
    `const signals = ${signals};`,
    'const missing = signals.filter((signal) => !text.includes(String(signal).toLowerCase()));',
    'if (missing.length > 0) { console.error(`missing required signal(s): ${missing.join(", ")}`); process.exit(1); }',
    ...scoreScaleValidatorLines(rubric.scoreScale),
    ...artifactOutputValidatorLines(blueprint.artifactOutputs),
    ...verificationPathValidatorLines(blueprint.verificationPath),
    'process.exit(0);',
  ];
  return lines.join('\n');
}

function scoreScaleLine(scale: NativeScoreScale): string {
  return `Score scale: ${scoreScaleLabels(scale.label).join(' or ')} ${scale.min}-${scale.max}${
    scale.increment === undefined ? '' : ` in ${scale.increment} increments`
  }`;
}

function scoreScaleValidatorLines(scale: NativeScoreScale | undefined): readonly string[] {
  if (scale === undefined) return [];
  const labels = scoreScaleLabels(scale.label);
  return [
    `const scoreLabels = ${JSON.stringify(labels)};`,
    'const scoreLabelText = scoreLabels.join(" or ");',
    'const escapedScoreLabels = scoreLabels.map((label) => label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&"));',
    'const scorePattern = new RegExp(`(?:${escapedScoreLabels.join("|")})\\\\s*[:=]?\\\\s*(-?\\\\d+(?:\\\\.\\\\d+)?)`, "gi");',
    'const scores = [...text.matchAll(scorePattern)].map((m) => Number(m[1]));',
    'if (scores.length === 0) { console.error(`no ${scoreLabelText} scores found`); process.exit(1); }',
    `const scoreMin = ${scale.min};`,
    `const scoreMax = ${scale.max};`,
    `const scoreIncrement = ${scale.increment ?? 0};`,
    'const outOfRange = scores.find((score) => score < scoreMin || score > scoreMax);',
    'if (outOfRange !== undefined) { console.error(`${scoreLabelText} out of range: ${outOfRange}`); process.exit(1); }',
    'if (scoreIncrement > 0) {',
    '  const offStep = scores.find((score) => Math.abs(scoreMin + Math.round((score - scoreMin) / scoreIncrement) * scoreIncrement - score) > 1e-9);',
    '  if (offStep !== undefined) { console.error(`${scoreLabelText} does not match increment ${scoreIncrement}: ${offStep}`); process.exit(1); }',
    '}',
  ];
}

function scoreScaleLabels(label: string): string[] {
  return label
    .split(/[|,]/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '');
}

function artifactOutputValidatorLines(outputs: readonly NativeArtifactOutput[] | undefined): readonly string[] {
  if (outputs === undefined || outputs.length === 0) return [];
  const compiled = outputs.map((output) => ({
    name: output.name,
    path: output.path,
    requiredSignals: [...output.requiredSignals],
  }));
  return [
    `const artifactOutputs = ${JSON.stringify(compiled)};`,
    'const missingArtifactSignals = artifactOutputs.flatMap((artifact) => [artifact.name, artifact.path, ...artifact.requiredSignals].filter((signal) => !text.includes(String(signal).toLowerCase())));',
    'if (missingArtifactSignals.length > 0) { console.error(`missing artifact output signal(s): ${missingArtifactSignals.join(", ")}`); process.exit(1); }',
  ];
}

function verificationPathValidatorLines(path: NativeVerificationPath | undefined): readonly string[] {
  if (path === undefined || path.successCriteria.length === 0) return [];
  return [
    `const verificationSignals = ${JSON.stringify(path.successCriteria)};`,
    'const missingVerificationSignals = verificationSignals.filter((signal) => !text.includes(String(signal).toLowerCase()));',
    'if (missingVerificationSignals.length > 0) { console.error(`missing verification signal(s): ${missingVerificationSignals.join(", ")}`); process.exit(1); }',
  ];
}

function optionalSection(title: string, items: readonly string[] | undefined): readonly string[] {
  return items === undefined || items.length === 0 ? [] : [section(title, items)];
}

function optionalArtifactOutputSection(outputs: readonly NativeArtifactOutput[] | undefined): readonly string[] {
  if (outputs === undefined || outputs.length === 0) return [];
  return [
    [
      'Artifact outputs:',
      ...outputs.map((output) =>
        [
          `- ${output.name} (${output.path}): ${output.description}`,
          `  Required signals: ${output.requiredSignals.join(', ')}`,
        ].join('\n'),
      ),
    ].join('\n'),
  ];
}

function optionalVerificationPathSection(path: NativeVerificationPath | undefined): readonly string[] {
  if (path === undefined) return [];
  return [
    [
      'Verification path:',
      ...path.steps.map((step) => `- Step: ${step}`),
      ...path.successCriteria.map((criterion) => `- Success criterion: ${criterion}`),
    ].join('\n'),
  ];
}

function modeSection(modes: readonly NativeMode[]): string {
  return [
    'Modes:',
    ...modes.map((mode) =>
      [`- ${mode.name}`, `  Trigger: ${mode.trigger}`, `  Workflow: ${mode.workflow.join(' -> ')}`, `  Output: ${mode.output}`].join('\n'),
    ),
  ].join('\n');
}

function section(title: string, items: readonly string[]): string {
  return [`${title}:`, ...items.map((item) => `- ${item}`)].join('\n');
}

function tiersFor(blueprint: NativeBlueprint): Record<string, string> {
  const tiers: Record<string, string> = { ...DEFAULT_TIERS };
  for (const [name, description] of Object.entries(blueprint.tiers)) {
    tiers[name] = sanitizeTierDescription(name, description);
  }
  return tiers;
}

function sanitizeTierDescription(name: string, description: string): string {
  const lowerName = name.toLowerCase();
  const lowerDescription = description.toLowerCase();
  if (lowerName === 'smart') return DEFAULT_TIERS.smart;
  if (lowerName === 'fast') return DEFAULT_TIERS.fast;
  if (/(gpt|openai|claude|anthropic|deepseek|gemini|llama|mistral)/i.test(description)) {
    return 'abstract specialist tier for domain-specific work';
  }
  if (/(gpt|openai|claude|anthropic|deepseek|gemini|llama|mistral)/i.test(lowerDescription)) {
    return 'abstract specialist tier for domain-specific work';
  }
  return description;
}

function synthesizeEvalCases(rubrics: readonly NativeRubric[], qualityGates: readonly string[]): string[] {
  const signals = [...new Set(rubrics.flatMap((rubric) => rubric.requiredSignals))];
  const signalText = signals.length === 0 ? 'the required rubric signals' : signals.join(', ');
  const gates = qualityGates.length === 0 ? 'the declared quality gates' : qualityGates.join('; ');
  return [`Reject outputs that miss ${signalText}; verify against quality gates: ${gates}.`];
}

function evalCasesFor(blueprint: NativeBlueprint): readonly SpecEvalCase[] {
  const rubricSignals = unique(blueprint.rubrics.flatMap((rubric) => rubric.requiredSignals));
  const fallbackSignals = unique([...blueprint.evidenceContract, ...blueprint.qualityGates]).slice(0, 5);
  const requiredSignals = rubricSignals.length > 0 ? rubricSignals : fallbackSignals;
  return blueprint.evalCases.map((prompt, index) => ({
    name: `eval-${index + 1}`,
    prompt,
    requiredSignals,
  }));
}

function unique(items: readonly string[]): string[] {
  return [...new Set(items)];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringField(o: Record<string, unknown>, key: string): string | undefined {
  const value = o[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function stringArrayField(o: Record<string, unknown>, key: string): string[] | undefined {
  return stringArray(o[key]);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return out.length === v.length ? out : undefined;
}

function modeArray(v: unknown): NativeMode[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NativeMode[] = [];
  for (const item of v) {
    if (!isRecord(item)) return undefined;
    const name = stringField(item, 'name');
    const trigger = stringField(item, 'trigger');
    const workflow = stringArrayField(item, 'workflow');
    const output = stringField(item, 'output');
    if (name === undefined || trigger === undefined || workflow === undefined || output === undefined) return undefined;
    out.push({ name, trigger, workflow, output });
  }
  return out;
}

function roleArray(v: unknown): NativeRole[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NativeRole[] = [];
  for (const item of v) {
    if (!isRecord(item)) return undefined;
    const name = stringField(item, 'name');
    const tier = stringField(item, 'tier');
    const tools = stringArrayField(item, 'tools');
    const mission = stringField(item, 'mission');
    const workflow = stringArrayField(item, 'workflow');
    const outputContract = stringArrayField(item, 'outputContract');
    if (
      name === undefined ||
      tier === undefined ||
      tools === undefined ||
      mission === undefined ||
      workflow === undefined ||
      outputContract === undefined
    ) {
      return undefined;
    }
    out.push({ name, tier, tools, mission, workflow, outputContract });
  }
  return out;
}

function rubricArray(v: unknown): NativeRubric[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: NativeRubric[] = [];
  for (const item of v) {
    if (!isRecord(item)) return undefined;
    const name = stringField(item, 'name');
    const prompt = stringField(item, 'prompt');
    const requiredSignals = stringArrayField(item, 'requiredSignals');
    const parsedScoreScale = scoreScaleField(item['scoreScale']);
    if (name === undefined || prompt === undefined || requiredSignals === undefined) return undefined;
    if (parsedScoreScale === undefined && item['scoreScale'] !== undefined) return undefined;
    const rubric = { name, prompt, requiredSignals };
    out.push(parsedScoreScale === undefined ? rubric : { ...rubric, scoreScale: parsedScoreScale });
  }
  return out;
}

function commandArray(v: unknown): NativeCommand[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out: NativeCommand[] = [];
  for (const item of v) {
    if (!isRecord(item)) return undefined;
    const name = stringField(item, 'name');
    const description = stringField(item, 'description');
    const template = stringField(item, 'template');
    if (name === undefined || description === undefined || template === undefined) return undefined;
    out.push({ name, description, template });
  }
  return out;
}

function artifactOutputArray(v: unknown): NativeArtifactOutput[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  const out: NativeArtifactOutput[] = [];
  for (const item of v) {
    if (!isRecord(item)) return undefined;
    const name = stringField(item, 'name');
    const path = stringField(item, 'path');
    const description = stringField(item, 'description');
    const requiredSignals = stringArrayField(item, 'requiredSignals');
    if (
      name === undefined ||
      path === undefined ||
      !isSafeArtifactPath(path) ||
      description === undefined ||
      requiredSignals === undefined
    ) {
      return undefined;
    }
    out.push({ name, path, description, requiredSignals });
  }
  return out;
}

function verificationPathField(v: unknown): NativeVerificationPath | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return undefined;
  const steps = stringArrayField(v, 'steps');
  const successCriteria = stringArrayField(v, 'successCriteria');
  return steps === undefined || steps.length === 0 || successCriteria === undefined || successCriteria.length === 0
    ? undefined
    : { steps, successCriteria };
}

function isSafeArtifactPath(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('~') || path.includes('\0') || path.includes('\\')) return false;
  return !path.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function memoryPolicy(v: unknown): NativeMemoryPolicy | undefined {
  if (!isRecord(v)) return undefined;
  const seeds = stringArrayField(v, 'seeds');
  const promotion = stringField(v, 'promotion');
  return seeds === undefined || promotion === undefined ? undefined : { seeds, promotion };
}

function tiersField(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    out[key] = value;
  }
  return out;
}

function scoreScaleField(v: unknown): NativeScoreScale | undefined {
  if (v === undefined) return undefined;
  if (!isRecord(v)) return undefined;
  const label = stringField(v, 'label');
  const min = numberField(v, 'min');
  const max = numberField(v, 'max');
  const increment = numberField(v, 'increment');
  if (label === undefined || min === undefined || max === undefined || min >= max) return undefined;
  if (scoreScaleLabels(label).length === 0) return undefined;
  if (increment !== undefined && increment <= 0) return undefined;
  return increment === undefined ? { label, min, max } : { label, min, max, increment };
}

function numberField(o: Record<string, unknown>, key: string): number | undefined {
  const value = o[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
