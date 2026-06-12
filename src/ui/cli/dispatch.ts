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

import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { platform } from 'node:os';
import { parseArgs, type ParsedCommand } from './args.ts';
import { runHeadless } from '../headless.ts';
import { runRepl, type ReplPorts } from '../repl.ts';
import { assembleLoopDeps, runTurn, type CallModel } from '../runtime.ts';
import { reduce } from '../../kernel/reducer.ts';
import { initialState, type SessionState } from '../../kernel/state.ts';
import type { LoopEvent } from '../../kernel/events.ts';
import type { TurnResult } from '../../kernel/loop.ts';
import { VERSION } from '../../version.ts';
import { loadConfig } from '../../config/load.ts';
import type { VegitoConfig, PermissionMode } from '../../config/schema.ts';
import { createSystemPrompt } from '../../context/prompt.ts';
import { IDENTITY, CONSTITUTION } from '../../context/identity.ts';
import { discoverMemoryFiles } from '../../context/discovery.ts';
import { ToolRegistry } from '../../tools/registry.ts';
import { makeBuiltinTools, type BuiltinSet } from '../../tools/index.ts';
import type { SkillSource, SkillMeta } from '../../tools/builtin/skill.ts';
import { createStore } from '../../sessions/store.ts';
import { loadPack } from '../../extend/packs.ts';
import { validatePack } from '../../extend/pack-validate.ts';
import { loadHooksFile, createHookBus, spawnHookRunner, type HookBus } from '../../extend/hooks.ts';
import { planFromFlags, inferPlan, interview, planToSpec, type ForgePlan } from '../../forge/interview.ts';
import { generatePack } from '../../forge/generate.ts';
import { enrichSpec } from '../../forge/enrich.ts';
import { observe, propose, applyProposals, revert, buildReviewer, type Gate } from '../../evolve/index.ts';
import { countNegativeConstraints } from '../../extend/pack-validate.ts';
import { createEngine } from '../../permissions/engine.ts';
import type { PermKey } from '../../tools/spec.ts';
import { BUILTIN_CATALOG } from '../../providers/catalog.ts';
import { resolveProfile } from '../../providers/profile.ts';
import { credentialFromEnv, baseUrlFromEnv } from '../../providers/credentials.ts';
import { buildWire, envVarForWire } from '../../providers/resolve.ts';
import { ScriptedWire, type ScriptedStep } from '../../providers/wire/scripted.ts';
import type { NeutralRequest, ProviderEvent } from '../../providers/types.ts';

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
const NO_SKILLS: SkillSource = { list: (): readonly SkillMeta[] => [], load: async () => undefined };

function usage(): string {
  return [
    'usage: vegito <command> [options]',
    '',
    'commands:',
    '  run -p <prompt> [--json] [--model m] [--mode default|acceptEdits|plan|bypass] [--cwd dir] [--script file]',
    '  repl [--model m] [--mode ...] [--cwd dir]',
    '  sessions list|resume <sid>|fork <sid> <recordId>',
    '  packs list|validate <dir>',
    '  forge [--offline] [--archetype id] [--domain "..."] [--name id] [--from docs] [--out dir]',
    '  evolve <pack> --session <sid> [--mode ...] [--script file]   (review a session, apply learned improvements)',
    '  evolve revert <pack>                                         (undo the last applied batch)',
    '  version | help',
    '',
  ].join('\n');
}

function effectiveConfig(base: VegitoConfig, c: ParsedCommand): VegitoConfig {
  if (c.cmd !== 'run' && c.cmd !== 'repl') return base;
  let cfg = base;
  if (c.model !== undefined) cfg = { ...cfg, model: c.model };
  if (c.mode !== undefined) cfg = { ...cfg, permissionMode: c.mode };
  return cfg;
}

// Build the model-call seam. `--script` reads a fixture and plays it through
// ScriptedWire (offline); otherwise resolve a catalog profile + env credential
// and build the live wire. Returns the provider display name alongside.
async function buildCallModel(
  model: string,
  scriptPath: string | undefined,
): Promise<{ callModel: CallModel; providerName: string }> {
  if (scriptPath !== undefined) {
    const text = await readFile(scriptPath, 'utf8');
    const steps = JSON.parse(text) as readonly ScriptedStep[];
    const wire = new ScriptedWire(steps);
    return { callModel: (req: NeutralRequest, sig: AbortSignal) => wire.send(req, sig), providerName: wire.name };
  }
  const profile = resolveProfile(BUILTIN_CATALOG, model);
  if (profile === undefined) throw new Error(`unknown model: ${model} (not in catalog)`);
  const envVar = envVarForWire(profile.wire);
  const credential = credentialFromEnv(profile.wire, envVar, profile.wire);
  if (credential === null) throw new Error(`missing credential: set ${envVar} to use ${profile.id}`);
  const baseUrl = baseUrlFromEnv(profile.wire);
  const wire = buildWire(profile, credential, baseUrl === undefined ? {} : { baseUrl });
  return { callModel: (req: NeutralRequest, sig: AbortSignal) => wire.send(req, sig), providerName: wire.name };
}

async function buildSystemTiers(cwd: string, homeDir: string): Promise<readonly string[]> {
  let memoryFiles: ReturnType<typeof discoverMemoryFiles> = [];
  try {
    memoryFiles = discoverMemoryFiles({ cwd, home: homeDir });
  } catch {
    memoryFiles = [];
  }
  const prompt = createSystemPrompt({
    identity: IDENTITY,
    constitution: CONSTITUTION,
    environment: { cwd, platform: platform(), date: new Date().toISOString().slice(0, 10) },
    memoryFiles,
    packs: [],
  });
  return prompt.tiers();
}

function buildRegistry(memoryDir: string): { registry: ToolRegistry; builtins: BuiltinSet } {
  const registry = new ToolRegistry();
  const builtins = makeBuiltinTools({ memoryDir, skills: NO_SKILLS });
  for (const tool of builtins.tools) registry.register(tool);
  return { registry, builtins };
}

// Project-level hooks: ./.vegito/hooks.json in the workspace, same layering
// spirit as config. A malformed file throws (callers abort the run) — hooks
// are the user's guardrails, so dropping them silently is the wrong failure.
async function buildHooks(cwd: string): Promise<HookBus | undefined> {
  const specs = await loadHooksFile(join(cwd, '.vegito', 'hooks.json'));
  if (specs.length === 0) return undefined;
  return createHookBus(specs, { runner: spawnHookRunner() });
}

async function cmdRun(c: Extract<ParsedCommand, { cmd: 'run' }>, ports: DispatchPorts): Promise<number> {
  const cwd = ports.cwd;
  const loaded = await loadConfig({ homeDir: ports.homeDir, cwd });
  for (const w of loaded.warnings) ports.writeErr(`config: ${w}\n`);
  const config = effectiveConfig(loaded.config, c);

  let seam: { callModel: CallModel; providerName: string };
  try {
    seam = await buildCallModel(config.model, c.script);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { registry, builtins } = buildRegistry(join(ports.homeDir, '.vegito', 'memory'));
  const systemTiers = await buildSystemTiers(cwd, ports.homeDir);
  const signal = ports.signal ?? new AbortController().signal;

  let hooks: HookBus | undefined;
  try {
    hooks = await buildHooks(cwd);
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

  const sid = `run-${APP_VERSION}`;
  const start = reduce(initialState({ sid, model: config.model, maxIterations: config.maxIterations }), {
    t: 'user_msg',
    blocks: [{ kind: 'text', text: c.prompt }],
  });

  try {
    const gen = runTurn(start, deps);
    const result = await runHeadless(gen, { write: ports.write, json: c.json });
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
  const cwd = ports.cwd;
  const loaded = await loadConfig({ homeDir: ports.homeDir, cwd });
  for (const w of loaded.warnings) ports.writeErr(`config: ${w}\n`);
  const config = effectiveConfig(loaded.config, c);

  let seam: { callModel: CallModel; providerName: string };
  try {
    seam = await buildCallModel(config.model, c.script);
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const { registry, builtins } = buildRegistry(join(ports.homeDir, '.vegito', 'memory'));
  const systemTiers = await buildSystemTiers(cwd, ports.homeDir);
  const signal = ports.signal ?? new AbortController().signal;

  let hooks: HookBus | undefined;
  try {
    hooks = await buildHooks(cwd);
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

  // The REPL keeps one evolving session: each line reduces into history, then
  // a turn runs. settleAsk bridges permission asks to the next input line.
  let state: SessionState = initialState({ sid: `repl-${APP_VERSION}`, model: config.model, maxIterations: config.maxIterations });

  const replPorts: ReplPorts = {
    nextLine: ports.nextLine,
    write: ports.write,
    startTurn: (text: string): AsyncGenerator<LoopEvent, TurnResult> => {
      state = reduce(state, { t: 'user_msg', blocks: [{ kind: 'text', text }] });
      const gen = runTurn(state, deps);
      // Capture the post-turn state so the next line continues the conversation.
      return (async function* (): AsyncGenerator<LoopEvent, TurnResult> {
        let step = await gen.next();
        while (!step.done) {
          yield step.value;
          step = await gen.next();
        }
        state = step.value.state;
        return step.value;
      })();
    },
    settleAsk: (askId: string, answer: string): void => {
      deps.exec.engine.broker.settle(askId, answer);
    },
  };

  try {
    await runRepl(replPorts);
    return 0;
  } finally {
    builtins.dispose();
  }
}

async function cmdSessions(c: Extract<ParsedCommand, { cmd: 'sessions' }>, ports: DispatchPorts): Promise<number> {
  const store = createStore({ root: join(ports.homeDir, '.vegito', 'sessions'), appVersion: APP_VERSION });
  if (c.sub === 'list') {
    const summaries = await store.list(ports.cwd).catch(() => []);
    if (summaries.length === 0) ports.write('no sessions\n');
    for (const s of summaries) ports.write(`${s.sid}  (${s.messageCount} msgs)  ${s.preview}\n`);
    return 0;
  }
  // resume/fork re-enter an interactive session; the surface is parsed and
  // routed here, but live replay wiring lands with the REPL session work.
  ports.writeErr(`sessions ${c.sub} is not wired to an interactive session yet\n`);
  return 1;
}

async function cmdPacks(c: Extract<ParsedCommand, { cmd: 'packs' }>, ports: DispatchPorts): Promise<number> {
  if (c.sub === 'list') {
    ports.write('pack discovery from config dirs is not configured in this build\n');
    return 0;
  }
  // validate
  if (c.path === undefined) {
    ports.writeErr('packs validate needs a pack directory\n');
    return 2;
  }
  try {
    const result = await validatePack(c.path);
    if (result.ok) {
      const pack = await loadPack(c.path);
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

// forge: resolve a plan (from docs, flags, or an interactive interview) → spec →
// optional model enrichment (online only) → write files → validate. Offline is
// deterministic and provider-free; the acceptance path. Output goes to --out or
// ./<pack-name> under cwd.
async function cmdForge(c: Extract<ParsedCommand, { cmd: 'forge' }>, ports: DispatchPorts): Promise<number> {
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
      const { callModel } = await buildCallModel(cfg.model, c.script);
      spec = await enrichSpec(spec, callModel, ports.signal ?? new AbortController().signal, cfg.model);
    } catch (err) {
      ports.writeErr(`note: persona enrichment skipped (${err instanceof Error ? err.message : String(err)})\n`);
    }
  }

  const outDir = c.out ?? join(ports.cwd, spec.name);
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
  ports.write(`  enable with: vegito packs validate ${outDir}\n`);
  return 0;
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
  const cfg = loaded.config;
  const signal = ports.signal ?? new AbortController().signal;
  let callModel: CallModel;
  try {
    ({ callModel } = await buildCallModel(cfg.model, c.script));
  } catch (err) {
    ports.writeErr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const reviewer = buildReviewer(callModel, signal, cfg.model);
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

  const proposals = propose(observations, { personaNegatives });
  if (proposals.length === 0) {
    ports.write(`${observations.length} observation(s), no actionable proposals — pack unchanged\n`);
    return 0;
  }

  const gate = buildEvolveGate(root, c.mode ?? 'acceptEdits');
  const result = await applyProposals(root, proposals, gate, { sids: [c.session] });

  if (result.problems && result.problems.length > 0) {
    ports.writeErr(`proposals failed validation — pack rolled back:\n`);
    for (const p of result.problems) ports.writeErr(`  - ${p}\n`);
    return 1;
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
