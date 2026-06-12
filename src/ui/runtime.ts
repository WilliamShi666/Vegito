// P10 composition root (DESIGN §11): assembleLoopDeps turns a model-call seam
// plus the session environment into the kernel's LoopDeps. Both UI surfaces
// share it; the wire is injected (live wires for `vegito run`, ScriptedWire
// for tests and forge offline), which is exactly what lets the whole agent run
// headlessly without a network. No effects here — transcript append and trace
// are the caller's job; this is pure wiring over the kernel's stages.

import { runTurn } from '../kernel/loop.ts';
import type { LoopDeps } from '../kernel/loop.ts';
import type { SessionState } from '../kernel/state.ts';
import { createRecoverer, retryAfterStrategy } from '../kernel/recovery.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { RwGate } from '../tools/gate.ts';
import { MessageBudget, DEFAULT_BUDGET } from '../tools/budget.ts';
import { FileState } from '../context/filestate.ts';
import { createEngine } from '../permissions/engine.ts';
import type { Rule } from '../permissions/rules.ts';
import type { HookBus } from '../extend/hooks.ts';
import type { PermissionMode, VegitoConfig } from '../config/schema.ts';
import type { NeutralRequest, ProviderEvent, ToolDef } from '../providers/types.ts';

export type CallModel = (req: NeutralRequest, signal: AbortSignal) => AsyncIterable<ProviderEvent>;

export interface RuntimeOptions {
  /** Display name of the active provider (model_call events). */
  readonly providerName: string;
  /** The model-call seam: a live wire's send(), or a scripted one in tests. */
  readonly callModel: CallModel;
  /** The fully-built tool surface (builtins + extensions). */
  readonly registry: ToolRegistry;
  /** Workspace root for write-containment in the permission engine. */
  readonly workspace: string;
  /** Permission mode, frozen into the engine at construction. */
  readonly mode: PermissionMode;
  /** Frozen system tiers (T1/T2) for the request prefix (D4). */
  readonly systemTiers: readonly string[];
  /** Merged config; supplies maxIterations and the per-request token ceiling. */
  readonly config: VegitoConfig;
  /** Turn-level abort. */
  readonly signal: AbortSignal;
  /** Permission rules; default none (mode alone governs). */
  readonly rules?: readonly Rule[];
  /** Lifecycle hook bus (PreToolUse/PostToolUse fire in the executor); default none. */
  readonly hooks?: HookBus;
  /** Per-request output token ceiling; default 4096. */
  readonly maxTokens?: number;
  /** Recovery attempts per model call; default 4. */
  readonly maxAttempts?: number;
}

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_ATTEMPTS = 4;

function toToolDefs(registry: ToolRegistry): readonly ToolDef[] {
  return registry.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema }));
}

export function assembleLoopDeps(opts: RuntimeOptions): LoopDeps {
  const tools = toToolDefs(opts.registry);
  const system = Object.freeze([...opts.systemTiers]);
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;

  const engine = createEngine({ workspace: opts.workspace, mode: opts.mode, rules: opts.rules ?? [] });
  const recoverer = createRecoverer([
    retryAfterStrategy({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
  ]);

  return {
    providerName: opts.providerName,
    assembleRequest: (s: SessionState): NeutralRequest => ({
      model: s.model,
      system,
      messages: s.history,
      tools,
      maxTokens,
    }),
    callModel: opts.callModel,
    exec: {
      registry: opts.registry,
      engine,
      gate: new RwGate(),
      budget: new MessageBudget(DEFAULT_BUDGET),
      ctx: { cwd: opts.workspace, signal: opts.signal, files: new FileState() },
      ...(opts.hooks === undefined ? {} : { hooks: opts.hooks }),
    },
    recoverer,
    signal: opts.signal,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
}

export { runTurn };
