import { readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { platform } from 'node:os';

import { runRepl, type ReplPorts } from '../repl.ts';
import { assembleLoopDeps, runTurn } from '../runtime.ts';
import { reduce } from '../../kernel/reducer.ts';
import { initialState, replaceState, type SessionState } from '../../kernel/state.ts';
import type { LoopEvent } from '../../kernel/events.ts';
import type { TurnResult } from '../../kernel/loop.ts';
import type { VegitoConfig } from '../../config/schema.ts';
import { createSystemPrompt } from '../../context/prompt.ts';
import { IDENTITY, CONSTITUTION } from '../../context/identity.ts';
import { discoverMemoryFiles } from '../../context/discovery.ts';
import { makeBuiltinTools, type BuiltinSet } from '../../tools/index.ts';
import { createExtensionRegistry } from '../../extend/registry.ts';
import { loadPack, type LoadedPack } from '../../extend/packs.ts';
import { loadHooksFile, createHookBus, spawnHookRunner, type HookBus, type HookSpec } from '../../extend/hooks.ts';
import type { Transcript } from '../../sessions/transcript.ts';
import type { NeutralMsg } from '../../providers/types.ts';

export function cwdFor(c: { readonly cwd?: string }, baseCwd: string): string {
  return c.cwd === undefined ? baseCwd : resolve(baseCwd, c.cwd);
}

export function expandPath(p: string, cwd: string, homeDir: string): string {
  if (p === '~') return homeDir;
  if (p.startsWith('~/')) return join(homeDir, p.slice(2));
  return isAbsolute(p) ? p : resolve(cwd, p);
}

export interface ActivePack {
  readonly spec: string;
  readonly pack: LoadedPack;
  readonly trusted: boolean;
}

async function readTrustedPacks(homeDir: string, config: VegitoConfig): Promise<ReadonlySet<string>> {
  const configured = config.trustedPacks;
  let local: readonly string[] = [];
  try {
    const raw = JSON.parse(await readFile(join(homeDir, '.vegito', 'trusted-packs.json'), 'utf8')) as unknown;
    local = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    local = [];
  }
  return new Set([...configured, ...local]);
}

function packCandidates(spec: string, config: VegitoConfig, cwd: string, homeDir: string): readonly string[] {
  const pathLike = isAbsolute(spec) || spec.startsWith('.') || spec.includes('/');
  if (pathLike) return [expandPath(spec, cwd, homeDir)];
  return config.packRoots.map((root) => join(expandPath(root, cwd, homeDir), spec));
}

async function resolvePackSpec(spec: string, config: VegitoConfig, cwd: string, homeDir: string): Promise<LoadedPack> {
  const errors: string[] = [];
  for (const candidate of packCandidates(spec, config, cwd, homeDir)) {
    try {
      return await loadPack(candidate);
    } catch (err) {
      errors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`pack not found: ${spec}${errors.length === 0 ? '' : ` (${errors.join('; ')})`}`);
}

export async function loadActivePacks(
  specs: readonly string[],
  config: VegitoConfig,
  cwd: string,
  homeDir: string,
): Promise<readonly ActivePack[]> {
  const trusted = await readTrustedPacks(homeDir, config);
  const packs: ActivePack[] = [];
  for (const spec of specs) {
    const pack = await resolvePackSpec(spec, config, cwd, homeDir);
    packs.push({
      spec,
      pack,
      trusted: trusted.has(spec) || trusted.has(pack.manifest.name) || trusted.has(pack.root),
    });
  }
  return packs;
}

async function packPromptLines(packs: readonly LoadedPack[]): Promise<readonly string[]> {
  const lines: string[] = [];
  for (const pack of packs) {
    lines.push(`${pack.manifest.name} v${pack.manifest.version}: ${pack.manifest.description}`);
    const persona = await readPackText(pack, pack.manifest.persona);
    if (persona !== undefined) lines.push(`Persona for ${pack.manifest.name}:\n${persona}`);

    const onboarding = await readPackText(pack, pack.manifest.onboarding);
    if (onboarding !== undefined) lines.push(`Onboarding for ${pack.manifest.name}:\n${onboarding}`);

    for (const agent of pack.manifest.agents) {
      const prompt = await readPackText(pack, agent.prompt);
      if (prompt !== undefined) lines.push(`Role prompt: ${agent.name}\n${prompt}`);
    }

    for (const rubric of pack.manifest.rubrics) {
      const prompt = await readPackText(pack, rubric.prompt);
      if (prompt !== undefined) lines.push(`Rubric: ${rubric.name}\n${prompt}`);
    }

    const memorySeeds = await readPackText(pack, pack.manifest.memory?.seeds);
    if (memorySeeds !== undefined) {
      lines.push(`Memory seeds for ${pack.manifest.name}:\n${memorySeeds}`);
    }
    if (pack.manifest.memory?.promotion !== undefined) lines.push(`Memory promotion for ${pack.manifest.name}:\n${pack.manifest.memory.promotion}`);
  }
  return lines;
}

async function readPackText(pack: LoadedPack, rel: string | undefined): Promise<string | undefined> {
  if (rel === undefined || rel === '') return undefined;
  try {
    return await readFile(join(pack.root, rel.replace(/^\.\//, '').split('/').join(sep)), 'utf8');
  } catch {
    // Validation reports missing pack files. Prompt assembly should not make an
    // otherwise valid run fail after validation already passed earlier.
    return undefined;
  }
}

export async function buildSystemTiers(
  cwd: string,
  homeDir: string,
  packs: readonly LoadedPack[] = [],
): Promise<readonly string[]> {
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
    packs: await packPromptLines(packs),
  });
  return prompt.tiers();
}

export async function buildRegistry(
  memoryDir: string,
  activePacks: readonly ActivePack[] = [],
): Promise<{
  registry: ReturnType<typeof createExtensionRegistry>['tools'];
  builtins: BuiltinSet;
  hookSpecs: readonly HookSpec[];
  commands: ReturnType<ReturnType<typeof createExtensionRegistry>['commands']>;
}> {
  const extensions = createExtensionRegistry();
  for (const active of activePacks) {
    await extensions.installPack(active.pack, { trusted: active.trusted });
  }
  const builtins = makeBuiltinTools({ memoryDir, skills: extensions.skills() });
  for (const tool of builtins.tools) extensions.tools.register(tool);
  return { registry: extensions.tools, builtins, hookSpecs: extensions.hookSpecs(), commands: extensions.commands() };
}

export async function buildHooks(cwd: string, packHooks: readonly HookSpec[] = []): Promise<HookBus | undefined> {
  const projectHooks = await loadHooksFile(join(cwd, '.vegito', 'hooks.json'));
  const specs = [...projectHooks, ...packHooks];
  if (specs.length === 0) return undefined;
  return createHookBus(specs, { runner: spawnHookRunner({ cwd }) });
}

function stateWithHistory(init: { sid: string; model: string; maxIterations: number }, history: readonly NeutralMsg[]): SessionState {
  return replaceState(initialState(init), { history: [...history] });
}

export async function appendHistoryDelta(transcript: Transcript, from: number, state: SessionState): Promise<void> {
  for (const msg of state.history.slice(from)) {
    await transcript.appendMsg(msg);
  }
}

export function replCommands(source: ReturnType<ReturnType<typeof createExtensionRegistry>['commands']>): ReplPorts['commands'] {
  const out: Record<string, (args: string) => string> = {};
  for (const cmd of source.list()) {
    out[cmd.name] = (args: string): string => source.render(cmd.name, args) ?? '';
  }
  return out;
}

export async function runInteractiveTranscript(opts: {
  readonly transcript: Transcript;
  readonly initialMessages: readonly NeutralMsg[];
  readonly modelId: string;
  readonly maxIterations: number;
  readonly deps: ReturnType<typeof assembleLoopDeps>;
  readonly commands: ReplPorts['commands'];
  readonly nextLine: () => Promise<string | null>;
  readonly write: (s: string) => void;
}): Promise<void> {
  let state: SessionState = stateWithHistory(
    { sid: opts.transcript.sid, model: opts.modelId, maxIterations: opts.maxIterations },
    opts.initialMessages,
  );
  const promptNextLine = async (): Promise<string | null> => {
    opts.write('vegito> ');
    const line = await opts.nextLine();
    if (line === null) opts.write('\n');
    return line;
  };
  opts.write(`vegito repl ready - session ${opts.transcript.sid}\n`);

  const replPorts: ReplPorts = {
    nextLine: promptNextLine,
    write: opts.write,
    ...(opts.commands === undefined ? {} : { commands: opts.commands }),
    startTurn: (text: string): AsyncGenerator<LoopEvent, TurnResult> => {
      const before = state.history.length;
      state = reduce(state, { t: 'user_msg', blocks: [{ kind: 'text', text }] });
      const gen = runTurn(state, opts.deps);
      return (async function* (): AsyncGenerator<LoopEvent, TurnResult> {
        let step = await gen.next();
        while (!step.done) {
          yield step.value;
          step = await gen.next();
        }
        state = step.value.state;
        await appendHistoryDelta(opts.transcript, before, state);
        return step.value;
      })();
    },
    settleAsk: (askId: string, answer: string): void => {
      opts.deps.exec.engine.broker.settle(askId, answer);
    },
  };

  await runRepl(replPorts);
}
