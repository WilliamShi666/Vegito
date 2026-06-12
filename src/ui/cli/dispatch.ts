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
import { join } from 'node:path';
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
import { BUILTIN_CATALOG } from '../../providers/catalog.ts';
import { resolveProfile } from '../../providers/profile.ts';
import { credentialFromEnv } from '../../providers/credentials.ts';
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
    '  forge        (meta-harness: build a custom pack)',
    '  evolve       (review and apply learned improvements)',
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
  const wire = buildWire(profile, credential);
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

async function cmdRun(c: Extract<ParsedCommand, { cmd: 'run' }>, ports: DispatchPorts): Promise<number> {
  const cwd = c.cwd ?? ports.cwd;
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

  const deps = assembleLoopDeps({
    providerName: seam.providerName,
    callModel: seam.callModel,
    registry,
    workspace: cwd,
    mode: config.permissionMode,
    systemTiers,
    config,
    signal,
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
  const cwd = c.cwd ?? ports.cwd;
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

  const deps = assembleLoopDeps({
    providerName: seam.providerName,
    callModel: seam.callModel,
    registry,
    workspace: cwd,
    mode: config.permissionMode,
    systemTiers,
    config,
    signal,
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
    const pack = await loadPack(c.path);
    ports.write(`pack "${pack.manifest.name}" v${pack.manifest.version} — valid\n`);
    return 0;
  } catch (err) {
    ports.writeErr(`invalid pack: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
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
      ports.writeErr('forge arrives in a later phase\n');
      return 1;
    case 'evolve':
      ports.writeErr('evolve arrives in a later phase\n');
      return 1;
    default: {
      const _exhaustive: never = cmd;
      void _exhaustive;
      return 2;
    }
  }
}
