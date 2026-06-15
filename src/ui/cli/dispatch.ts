// P10 dispatch (DESIGN §11): the one impure CLI entry. It parses argv, routes
// to a handler, and returns a process exit code. Everything with an effect —
// stdout/stderr, home/cwd, the turn signal, REPL line input — arrives as a
// DispatchPorts seam, so the entire CLI is exercised offline in tests through
// a ScriptedWire fixture: no network, no real TTY, no environment reads here.
//
// The model-call seam is chosen per invocation: `--script <file>` plays a JSON
// fixture through ScriptedWire (the offline path forge reuses); otherwise the
// live wire is built from catalog + env credentials. Env reads stay inside
// credentials.ts (A5); this module only orchestrates.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { parseArgs, type ParsedCommand } from './args.ts';
import { runHeadless } from '../headless.ts';
import { assembleLoopDeps, runTurn, type CallModel } from '../runtime.ts';
import { reduce } from '../../kernel/reducer.ts';
import { initialState } from '../../kernel/state.ts';
import { VERSION } from '../../version.ts';
import { loadConfig } from '../../config/load.ts';
import type { VegitoConfig, PermissionMode } from '../../config/schema.ts';
import { createStore } from '../../sessions/store.ts';
import type { Transcript } from '../../sessions/transcript.ts';
import { loadPack } from '../../extend/packs.ts';
import { validatePack } from '../../extend/pack-validate.ts';
import type { HookBus } from '../../extend/hooks.ts';
import {
  appendHistoryDelta,
  buildHooks,
  buildRegistry,
  buildSystemTiers,
  cwdFor,
  expandPath,
  loadActivePacks,
  replCommands,
  runInteractiveTranscript,
  type ActivePack,
} from './runtime-support.ts';
import { planFromFlags, inferPlan, interview, planToSpec, type ForgePlan } from '../../forge/interview.ts';
import { generatePack } from '../../forge/generate.ts';
import { enrichSpec } from '../../forge/enrich.ts';
import { forgeNativeSpec } from '../../forge/native-blueprint.ts';
import {
  observe,
  propose,
  applyProposals,
  revert,
  buildReviewer,
  evaluateCandidateBundle,
  validateCandidateBundle,
  validateEvalCases,
  appendEditLedgerRecords,
  appendRejectedEditRecords,
  loadRejectedFingerprints,
  promotionPlanFromEval,
  toEditLedgerRecords,
  toRejectedEditRecords,
  type Gate,
} from '../../evolve/index.ts';
import { countNegativeConstraints } from '../../extend/pack-validate.ts';
import { createEngine } from '../../permissions/engine.ts';
import type { PermKey } from '../../tools/spec.ts';
import type { NeutralMsg, ProviderEvent } from '../../providers/types.ts';
import { buildCallModel, catalogFilesFor, effectiveConfig, usage, writeCatalogWarnings, type ModelSeam } from './dispatch-support.ts';
import { validatePackOutput } from './output-validation.ts';
import { listGeneratedPacks, renderGeneratedPacks } from './generated-packs.ts';

export { buildCallModel } from './dispatch-support.ts';

export interface DispatchPorts {
  readonly write: (s: string) => void;
  readonly writeErr: (s: string) => void;
  readonly homeDir: string;
  readonly cwd: string;
  /** Turn-level abort; the bin wires this to SIGINT. Optional in tests. */
  readonly signal?: AbortSignal;
  /** REPL input source; required only for the interactive `repl` command. */
  readonly nextLine?: () => Promise<string | null>;
}

const APP_VERSION = VERSION;

async function cmdRun(c: Extract<ParsedCommand, { cmd: 'run' }>, ports: DispatchPorts): Promise<number> {
  const cwd = cwdFor(c, ports.cwd);
  const loaded = await loadConfig({ homeDir: ports.homeDir, cwd });
  for (const w of loaded.warnings) ports.writeErr(`config: ${w}\n`);
  const config = effectiveConfig(loaded.config, c);

  let seam: ModelSeam;
  try {
    seam = await buildCallModel(config.model, c.script, catalogFilesFor(config, cwd, ports.homeDir));
    writeCatalogWarnings(seam.warnings, ports);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let activePacks: readonly ActivePack[];
  try {
    activePacks = await loadActivePacks(c.packs, config, cwd, ports.homeDir);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { registry, builtins, hookSpecs } = await buildRegistry(join(ports.homeDir, '.vegito', 'memory'), activePacks);
  const systemTiers = await buildSystemTiers(cwd, ports.homeDir, activePacks.map((p) => p.pack));
  const signal = ports.signal ?? new AbortController().signal;

  let hooks: HookBus | undefined;
  try {
    hooks = await buildHooks(cwd, hookSpecs);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    builtins.dispose();
    return 1;
  }

  const deps = assembleLoopDeps({
    providerName: seam.providerName,
    callModel: seam.callModel,
    registry,
    workspace: cwd,
    mode: config.permissionMode,
    systemTiers,
    config,
    signal,
    ...(hooks === undefined ? {} : { hooks }),
  });

  const store = createStore({ root: join(ports.homeDir, '.vegito', 'sessions'), appVersion: APP_VERSION });
  const transcript = await store.create(cwd);
  const sid = transcript.sid;
  const start = reduce(initialState({ sid, model: seam.modelId, maxIterations: config.maxIterations }), {
    t: 'user_msg',
    blocks: [{ kind: 'text', text: c.prompt }],
  });

  try {
    const gen = runTurn(start, deps);
    const result = await runHeadless(gen, { write: ports.write, json: c.json });
    await appendHistoryDelta(transcript, 0, result.state);
    return result.code;
  } finally {
    builtins.dispose();
  }
}

async function cmdRepl(c: Extract<ParsedCommand, { cmd: 'repl' }>, ports: DispatchPorts): Promise<number> {
  if (ports.nextLine === undefined) {
    ports.writeErr('repl requires an input stream\n');
    return 1;
  }
  const cwd = cwdFor(c, ports.cwd);
  const loaded = await loadConfig({ homeDir: ports.homeDir, cwd });
  for (const w of loaded.warnings) ports.writeErr(`config: ${w}\n`);
  const config = effectiveConfig(loaded.config, c);

  let seam: ModelSeam;
  try {
    seam = await buildCallModel(config.model, c.script, catalogFilesFor(config, cwd, ports.homeDir));
    writeCatalogWarnings(seam.warnings, ports);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  let activePacks: readonly ActivePack[];
  try {
    activePacks = await loadActivePacks(c.packs, config, cwd, ports.homeDir);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { registry, builtins, hookSpecs, commands } = await buildRegistry(join(ports.homeDir, '.vegito', 'memory'), activePacks);
  const systemTiers = await buildSystemTiers(cwd, ports.homeDir, activePacks.map((p) => p.pack));
  const signal = ports.signal ?? new AbortController().signal;

  let hooks: HookBus | undefined;
  try {
    hooks = await buildHooks(cwd, hookSpecs);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    builtins.dispose();
    return 1;
  }

  const deps = assembleLoopDeps({
    providerName: seam.providerName,
    callModel: seam.callModel,
    registry,
    workspace: cwd,
    mode: config.permissionMode,
    systemTiers,
    config,
    signal,
    ...(hooks === undefined ? {} : { hooks }),
  });

  const store = createStore({ root: join(ports.homeDir, '.vegito', 'sessions'), appVersion: APP_VERSION });
  const transcript = await store.create(cwd);

  try {
    await runInteractiveTranscript({
      transcript,
      initialMessages: [],
      modelId: seam.modelId,
      maxIterations: config.maxIterations,
      deps,
      commands: replCommands(commands),
      nextLine: ports.nextLine,
      write: ports.write,
    });
    return 0;
  } finally {
    builtins.dispose();
  }
}

async function cmdSessions(c: Extract<ParsedCommand, { cmd: 'sessions' }>, ports: DispatchPorts): Promise<number> {
  const cwd = cwdFor(c, ports.cwd);
  const store = createStore({ root: join(ports.homeDir, '.vegito', 'sessions'), appVersion: APP_VERSION });
  if (c.sub === 'list') {
    const summaries = await store.list(cwd).catch(() => []);
    if (summaries.length === 0) ports.write('no sessions\n');
    for (const s of summaries) ports.write(`${s.sid}  (${s.messageCount} msgs)  ${s.preview}\n`);
    return 0;
  }
  if (ports.nextLine === undefined) {
    ports.writeErr(`sessions ${c.sub} requires an input stream\n`);
    return 1;
  }
  if (c.target === undefined) {
    ports.writeErr(`sessions ${c.sub} needs a session id\n`);
    return 2;
  }

  let transcript: Transcript;
  try {
    transcript =
      c.sub === 'resume'
        ? await store.resume(cwd, c.target)
        : await store.fork(cwd, c.target, c.at ?? '');
  } catch (err) {
    ports.writeErr(`cannot ${c.sub} session ${c.target}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  if (c.sub === 'fork') ports.write(`forked ${c.target} at ${c.at} -> ${transcript.sid}\n`);

  let initialMessages: readonly NeutralMsg[];
  try {
    initialMessages = await store.resolve(cwd, transcript.sid);
  } catch (err) {
    ports.writeErr(`cannot resolve session ${transcript.sid}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const loaded = await loadConfig({ homeDir: ports.homeDir, cwd });
  for (const w of loaded.warnings) ports.writeErr(`config: ${w}\n`);
  const config = loaded.config;

  let seam: ModelSeam;
  try {
    seam = await buildCallModel(config.model, c.script, catalogFilesFor(config, cwd, ports.homeDir));
    writeCatalogWarnings(seam.warnings, ports);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { registry, builtins, hookSpecs, commands } = await buildRegistry(join(ports.homeDir, '.vegito', 'memory'));
  const systemTiers = await buildSystemTiers(cwd, ports.homeDir);
  const signal = ports.signal ?? new AbortController().signal;

  let hooks: HookBus | undefined;
  try {
    hooks = await buildHooks(cwd, hookSpecs);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    builtins.dispose();
    return 1;
  }

  const deps = assembleLoopDeps({
    providerName: seam.providerName,
    callModel: seam.callModel,
    registry,
    workspace: cwd,
    mode: config.permissionMode,
    systemTiers,
    config,
    signal,
    ...(hooks === undefined ? {} : { hooks }),
  });

  try {
    await runInteractiveTranscript({
      transcript,
      initialMessages,
      modelId: seam.modelId,
      maxIterations: config.maxIterations,
      deps,
      commands: replCommands(commands),
      nextLine: ports.nextLine,
      write: ports.write,
    });
    return 0;
  } finally {
    builtins.dispose();
  }
}

async function cmdPacks(c: Extract<ParsedCommand, { cmd: 'packs' }>, ports: DispatchPorts): Promise<number> {
  const cwd = cwdFor(c, ports.cwd);
  if (c.sub === 'list') {
    const loaded = await loadConfig({ homeDir: ports.homeDir, cwd });
    for (const w of loaded.warnings) ports.writeErr(`config: ${w}\n`);
    let count = 0;
    for (const rootSpec of loaded.config.packRoots) {
      const root = expandPath(rootSpec, cwd, ports.homeDir);
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch {
        continue;
      }
      for (const entry of entries) {
        try {
          const pack = await loadPack(join(root, entry));
          ports.write(`${pack.manifest.name}  v${pack.manifest.version}  ${pack.root}\n`);
          count += 1;
        } catch {
          continue;
        }
      }
    }
    if (count === 0) ports.write('no packs\n');
    return 0;
  }
  if (c.sub === 'generated') {
    ports.write(renderGeneratedPacks(await listGeneratedPacks(cwd)));
    return 0;
  }
  if (c.sub === 'prompt') {
    ports.write(renderPromptTiers(await buildSystemTiers(cwd, ports.homeDir)));
    return 0;
  }
  if (c.sub === 'trust') {
    if (c.path === undefined) {
      ports.writeErr('packs trust needs a pack name or directory\n');
      return 2;
    }
    const dir = join(ports.homeDir, '.vegito');
    const file = join(dir, 'trusted-packs.json');
    let existing: readonly string[] = [];
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
      existing = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      existing = [];
    }
    const next = [...new Set([...existing, c.path])].sort();
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    ports.write(`trusted pack: ${c.path}\n`);
    return 0;
  }
  if (c.sub === 'validate-output') {
    if (c.path === undefined || c.candidate === undefined) {
      ports.writeErr('packs validate-output needs <pack> <candidate-file>\n');
      return 2;
    }
    return validatePackOutput(c.path, c.candidate, cwd, ports);
  }
  // validate
  if (c.path === undefined) {
    ports.writeErr('packs validate needs a pack directory\n');
    return 2;
  }
  const packPath = expandPath(c.path, cwd, ports.homeDir);
  try {
    const result = await validatePack(packPath);
    if (result.ok) {
      const pack = await loadPack(packPath);
      ports.write(`pack "${pack.manifest.name}" v${pack.manifest.version} — valid\n`);
      return 0;
    }
    ports.writeErr(`invalid pack — ${result.problems.length} problem(s):\n`);
    for (const p of result.problems) ports.writeErr(`  - ${p}\n`);
    return 1;
  } catch (err) {
    ports.writeErr(`invalid pack: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function renderPromptTiers(tiers: readonly string[]): string {
  return `${tiers.map((tier, index) => `# System tier ${index + 1}\n${tier}`).join('\n\n')}\n`;
}

// forge: resolve a plan (from docs, flags, or an interactive interview) → spec →
// optional model enrichment (online only) → write files → validate. Offline is
// deterministic and provider-free; the acceptance path. Output goes to --out or
// generated/<pack-name> under cwd.
async function cmdForge(c: Extract<ParsedCommand, { cmd: 'forge' }>, ports: DispatchPorts): Promise<number> {
  if (c.native) return cmdForgeNative(c, ports);

  const plan = await resolveForgePlan(c, ports);
  if (plan === undefined) return 2; // message already written
  if ('error' in plan) {
    ports.writeErr(`${plan.error}\n`);
    return 2;
  }

  let spec = planToSpec(plan);

  // Online path: one bounded model call refines the persona. Never fatal — if
  // no seam is available we keep the template persona and say so.
  if (!c.offline) {
    try {
      const loaded = await loadConfig({ homeDir: ports.homeDir, cwd: ports.cwd });
      const cfg = loaded.config;
      const { callModel, modelId, warnings } = await buildCallModel(cfg.model, c.script, catalogFilesFor(cfg, ports.cwd, ports.homeDir));
      writeCatalogWarnings(warnings, ports);
      spec = await enrichSpec(spec, callModel, ports.signal ?? new AbortController().signal, modelId);
    } catch (err) {
      ports.writeErr(`note: persona enrichment skipped (${err instanceof Error ? err.message : String(err)})\n`);
    }
  }

  const outDir = forgeOutDir(c.out, ports.cwd, spec.name);
  try {
    await generatePack(outDir, spec);
  } catch (err) {
    ports.writeErr(`forge failed to write pack: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const result = await validatePack(outDir);
  if (!result.ok) {
    ports.writeErr(`forged pack failed validation — ${result.problems.length} problem(s):\n`);
    for (const p of result.problems) ports.writeErr(`  - ${p}\n`);
    return 1;
  }

  ports.write(`forged pack "${spec.name}" (${plan.archetype}) at ${outDir}\n`);
  ports.write(`  ${spec.agents.length} agents, ${spec.rubrics.length} rubric(s) — validated clean\n`);
  ports.write(`  use with: vegito repl --pack ${outDir}\n`);
  ports.write(`  one-shot: vegito run --pack ${outDir} -p "your task"\n`);
  ports.write(`  validate with: vegito packs validate ${outDir}\n`);
  return 0;
}

async function cmdForgeNative(c: Extract<ParsedCommand, { cmd: 'forge' }>, ports: DispatchPorts): Promise<number> {
  if (c.offline) {
    ports.writeErr('forge --native needs a model call; remove --offline or provide --script for deterministic tests\n');
    return 2;
  }
  if (c.archetype !== undefined) {
    ports.writeErr('forge --native does not accept --archetype; native generation is template-isolated\n');
    return 2;
  }

  let docs: string | undefined;
  if (c.from !== undefined) {
    try {
      docs = await readFile(c.from, 'utf8');
    } catch (err) {
      ports.writeErr(`cannot read --from ${c.from}: ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  if (c.domain === undefined && docs === undefined) {
    ports.writeErr('forge --native needs --domain or --from docs\n');
    return 2;
  }

  let spec: Awaited<ReturnType<typeof forgeNativeSpec>>;
  try {
    const loaded = await loadConfig({ homeDir: ports.homeDir, cwd: ports.cwd });
    const cfg = loaded.config;
    const { callModel, modelId, warnings } = await buildCallModel(cfg.model, c.script, catalogFilesFor(cfg, ports.cwd, ports.homeDir));
    writeCatalogWarnings(warnings, ports);
    spec = await forgeNativeSpec({
      ...(c.domain !== undefined ? { domain: c.domain } : {}),
      ...(docs !== undefined ? { docs } : {}),
      ...(c.name !== undefined ? { name: c.name } : {}),
      callModel,
      signal: ports.signal ?? new AbortController().signal,
      model: modelId,
    });
  } catch (err) {
    ports.writeErr(`native forge failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const outDir = forgeOutDir(c.out, ports.cwd, spec.name);
  try {
    await generatePack(outDir, spec);
  } catch (err) {
    ports.writeErr(`forge failed to write pack: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const result = await validatePack(outDir);
  if (!result.ok) {
    ports.writeErr(`forged pack failed validation — ${result.problems.length} problem(s):\n`);
    for (const p of result.problems) ports.writeErr(`  - ${p}\n`);
    return 1;
  }

  ports.write(`forged pack "${spec.name}" (native) at ${outDir}\n`);
  ports.write(`  ${spec.agents.length} agents, ${spec.rubrics.length} rubric(s) — validated clean\n`);
  ports.write(`  use with: vegito repl --pack ${outDir}\n`);
  ports.write(`  one-shot: vegito run --pack ${outDir} -p "your task"\n`);
  ports.write(`  validate with: vegito packs validate ${outDir}\n`);
  return 0;
}

function forgeOutDir(out: string | undefined, cwd: string, packName: string): string {
  return out ?? join(cwd, 'generated', packName);
}

// Returns a plan, an {error}, or undefined when it already wrote a usage message.
async function resolveForgePlan(
  c: Extract<ParsedCommand, { cmd: 'forge' }>,
  ports: DispatchPorts,
): Promise<ForgePlan | { error: string } | undefined> {
  if (c.from !== undefined) {
    let docs: string;
    try {
      docs = await readFile(c.from, 'utf8');
    } catch (err) {
      ports.writeErr(`cannot read --from ${c.from}: ${err instanceof Error ? err.message : String(err)}\n`);
      return undefined;
    }
    return inferPlan(docs, c.name);
  }

  // Flags fully specify the plan when a domain is present (required for offline).
  if (c.offline || c.domain !== undefined) {
    return planFromFlags({
      ...(c.archetype !== undefined ? { archetype: c.archetype } : {}),
      ...(c.domain !== undefined ? { domain: c.domain } : {}),
      ...(c.name !== undefined ? { name: c.name } : {}),
    });
  }

  // Interactive: needs a line source.
  if (ports.nextLine === undefined) {
    return { error: 'forge needs --domain (or an interactive terminal) to proceed' };
  }
  const next = ports.nextLine;
  const ask = async (question: string): Promise<string> => {
    ports.write(`${question}\n> `);
    const line = await next();
    return line ?? '';
  };
  return interview(ask);
}

// Build a gate that routes every proposal through the permission engine — the
// same gate any write faces. A proposal's target is resolved to an absolute
// path under the pack root; a non-allow verdict (deny, or an ask that nothing
// settles in this non-interactive path) fails closed.
function buildEvolveGate(root: string, mode: PermissionMode): Gate {
  const engine = createEngine({ workspace: root, mode, rules: [] });
  return async (p): Promise<'allow' | 'deny'> => {
    const rel = p.kind === 'pack_edit' ? p.target : `memory/${p.to}.md`;
    const key: PermKey = { tool: 'evolve', action: 'write', target: join(root, rel) };
    const res = await engine.check(key);
    return res === 'allow' ? 'allow' : 'deny';
  };
}

async function cmdEvolve(c: Extract<ParsedCommand, { cmd: 'evolve' }>, ports: DispatchPorts): Promise<number> {
  const root = isAbsolute(c.pack) ? c.pack : join(ports.cwd, c.pack);

  // A pack must exist and validate before we touch it either way.
  const pre = await validatePack(root);
  if (!pre.ok) {
    ports.writeErr(`pack at ${root} is not valid:\n`);
    for (const p of pre.problems) ports.writeErr(`  - ${p}\n`);
    return 1;
  }

  if (c.sub === 'revert') {
    const rec = await revert(root);
    if (rec === undefined) {
      ports.write('nothing to revert\n');
      return 0;
    }
    ports.write(`reverted "${c.pack}" from ${rec.version} to ${rec.prevVersion}\n`);
    return 0;
  }
  if (c.sub === 'eval') {
    const pack = await loadPack(root);
    if (c.candidate === undefined || c.evalCases === undefined) {
      ports.write(`evolve eval: pack "${pack.manifest.name}" baseline ${pack.manifest.version}; 0 candidate(s), 0 applied\n`);
      return 0;
    }
    let candidateRaw: unknown;
    let casesRaw: unknown;
    try {
      candidateRaw = JSON.parse(await readFile(isAbsolute(c.candidate) ? c.candidate : join(ports.cwd, c.candidate), 'utf8'));
      casesRaw = JSON.parse(await readFile(isAbsolute(c.evalCases) ? c.evalCases : join(ports.cwd, c.evalCases), 'utf8'));
    } catch (err) {
      ports.writeErr(`cannot read evolve eval input: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    const validated = validateCandidateBundle(candidateRaw);
    if (!validated.ok) {
      ports.writeErr(`invalid candidate: ${validated.reason}\n`);
      return 1;
    }
    const validatedCases = validateEvalCases(casesRaw);
    if (!validatedCases.ok) {
      ports.writeErr(`invalid evolve eval case: ${validatedCases.reason}\n`);
      return 1;
    }
    const rejectedFingerprints = await loadRejectedFingerprints(root);
    const report = evaluateCandidateBundle(validated.value, validatedCases.value, { rejectedFingerprints });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (c.report !== undefined) {
      const reportPath = isAbsolute(c.report) ? c.report : join(ports.cwd, c.report);
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, text, 'utf8');
    }
    if (!c.apply && report.decision.verdict !== 'rejected') {
      await appendEditLedgerRecords(
        root,
        toEditLedgerRecords(
          validated.value,
          report,
          report.decision.verdict === 'partial' ? 'partial' : 'accepted',
        ),
      );
    }
    await appendRejectedEditRecords(root, toRejectedEditRecords(validated.value, report));
    if (c.apply && report.decision.verdict !== 'rejected') {
      const plan = promotionPlanFromEval(validated.value, report);
      if (plan.problems.length > 0) {
        ports.writeErr(`candidate cannot be promoted durably:\n`);
        for (const problem of plan.problems) ports.writeErr(`  - ${problem}\n`);
        return 1;
      }
      const applyResult = await applyProposals(root, plan.proposals, buildEvolveGate(root, c.mode ?? 'acceptEdits'), {
        sids: validated.value.diagnosis.evidenceIds,
      });
      if (applyResult.problems && applyResult.problems.length > 0 && applyResult.applied.length === 0) {
        ports.writeErr(`candidate promotion failed — pack rolled back:\n`);
        for (const problem of applyResult.problems) ports.writeErr(`  - ${problem}\n`);
        return 1;
      }
      if (applyResult.denied.length > 0) {
        ports.writeErr(`candidate promotion denied ${applyResult.denied.length} proposal(s)\n`);
        return 1;
      }
      await appendEditLedgerRecords(
        root,
        toEditLedgerRecords(
          validated.value,
          report,
          report.decision.verdict === 'partial' ? 'partial' : 'accepted',
        ),
      );
    }
    ports.write(text);
    return 0;
  }

  // run: review one session, propose, apply through the gate.
  if (c.session === undefined) {
    ports.writeErr('evolve run needs --session <sid> to review\n');
    return 2;
  }
  const store = createStore({ root: join(ports.homeDir, '.vegito', 'sessions'), appVersion: APP_VERSION });
  let messages;
  try {
    messages = await store.resolve(ports.cwd, c.session);
  } catch (err) {
    ports.writeErr(`cannot resolve session ${c.session}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const loaded = await loadConfig({ homeDir: ports.homeDir, cwd: ports.cwd });
  for (const w of loaded.warnings) ports.writeErr(`config: ${w}\n`);
  const cfg = loaded.config;
  const signal = ports.signal ?? new AbortController().signal;
  let callModel: CallModel;
  let modelId: string;
  try {
    const seam = await buildCallModel(cfg.model, c.script, catalogFilesFor(cfg, ports.cwd, ports.homeDir));
    writeCatalogWarnings(seam.warnings, ports);
    ({ callModel, modelId } = seam);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const reviewer = buildReviewer(callModel, signal, modelId);
  const observations = await observe(c.session, messages, reviewer);
  if (observations.length === 0) {
    ports.write('no observations — pack unchanged\n');
    return 0;
  }

  // Budget the persona constraints against what is already there.
  let personaNegatives = 0;
  try {
    personaNegatives = countNegativeConstraints(await readFile(join(root, 'persona.md'), 'utf8'));
  } catch {
    personaNegatives = 0;
  }

  let pack: Awaited<ReturnType<typeof loadPack>>;
  try {
    pack = await loadPack(root);
  } catch (err) {
    ports.writeErr(`cannot load pack ${root}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const proposals = propose(observations, {
    personaNegatives,
    knownRubrics: pack.manifest.rubrics.map((r) => r.name),
  });
  if (proposals.length === 0) {
    ports.write(`${observations.length} observation(s), no actionable proposals — pack unchanged\n`);
    return 0;
  }

  const shouldApply = c.apply || cfg.evolve.defaultApply;
  if (!shouldApply) {
    ports.write(`evolve review-only: ${observations.length} observation(s), ${proposals.length} proposal(s), 0 applied\n`);
    for (const p of proposals) {
      const target = p.kind === 'pack_edit' ? p.target : `memory/${p.to}.md`;
      ports.write(`  - ${p.id} ${p.kind} -> ${target}\n`);
    }
    ports.write(`  apply with: vegito evolve ${c.pack} --session ${c.session} --apply\n`);
    return 0;
  }

  const gate = buildEvolveGate(root, c.mode ?? 'acceptEdits');
  const result = await applyProposals(root, proposals, gate, { sids: [c.session] });

  if (result.problems && result.problems.length > 0 && result.applied.length === 0) {
    ports.writeErr(`proposals failed validation — pack rolled back:\n`);
    for (const p of result.problems) ports.writeErr(`  - ${p}\n`);
    return 1;
  }
  if (result.problems && result.problems.length > 0) {
    ports.writeErr(`some proposals were rejected before application:\n`);
    for (const p of result.problems) ports.writeErr(`  - ${p}\n`);
  }
  ports.write(
    `evolve: ${observations.length} observation(s) → ${result.applied.length} applied, ${result.denied.length} denied\n`,
  );
  if (result.applied.length > 0) ports.write(`  revert with: vegito evolve revert ${c.pack}\n`);
  return 0;
}

export async function dispatch(argv: readonly string[], ports: DispatchPorts): Promise<number> {
  const cmd = parseArgs(argv);
  switch (cmd.cmd) {
    case 'version':
      ports.write(`vegito ${APP_VERSION}\n`);
      return 0;
    case 'help':
      ports.write(usage());
      return 0;
    case 'error':
      ports.writeErr(`${cmd.message}\n\n${usage()}`);
      return 2;
    case 'run':
      return cmdRun(cmd, ports);
    case 'repl':
      return cmdRepl(cmd, ports);
    case 'sessions':
      return cmdSessions(cmd, ports);
    case 'packs':
      return cmdPacks(cmd, ports);
    case 'forge':
      return cmdForge(cmd, ports);
    case 'evolve':
      return cmdEvolve(cmd, ports);
    default: {
      const _exhaustive: never = cmd;
      void _exhaustive;
      return 2;
    }
  }
}
