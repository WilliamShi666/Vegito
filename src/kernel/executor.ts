import type { LoopEvent } from './events.ts';
import type { PendingCall } from './state.ts';
import type { ToolResultInput } from './reducer.ts';
import { ModelFacingError, isModelFacing } from './errors.ts';
import type { ToolRegistry } from '../tools/registry.ts';
import type { ToolCtx, ToolSpec } from '../tools/spec.ts';
import { validateToolInput } from '../tools/validate.ts';
import { RwGate, type GateMode } from '../tools/gate.ts';
import { MessageBudget } from '../tools/budget.ts';
import type { Engine } from '../permissions/engine.ts';
import type { HookBus } from '../extend/hooks.ts';

// The tool execution stage (DESIGN §3.2, §7.1, L4). Drives the model's
// pending tool calls through the pipeline: validate → permission gate (which
// may surface an `ask`) → PreToolUse hooks → partition (concurrency-safe reads
// parallelize, writes run exclusively via the RwGate) → run → PostToolUse hooks
// → output budget. It is an async generator: it *yields* LoopEvents (tool_start,
// ask, tool_end) for any UI and *returns* the ToolResultInput[] the reducer
// folds back into history.
//
// Hooks are augmentation layered over the permission gate, never a replacement
// for it (the gate has already spoken by the time PreToolUse fires). A
// PreToolUse block fails the call before run(); a PostToolUse block flips an
// already-run result to failed so the model self-repairs. allow-hook stdout is
// injected into the result as context. The bus never throws (it degrades to
// warn internally), so hooks cannot wedge the loop.
//
// Every failure becomes a failed tool_result, never a thrown turn-ender (L9):
// the model sees the error and self-repairs. Calls are launched up front so
// safe reads overlap, but results and events stay in call order — determinism
// the trace and tests depend on (D11).

export interface ExecDeps {
  registry: ToolRegistry;
  engine: Engine;
  gate: RwGate;
  budget: MessageBudget;
  ctx: ToolCtx;
  /** Optional lifecycle hooks. Absent → no dispatch, behavior unchanged. */
  hooks?: HookBus;
}

type Disposition =
  | { kind: 'failed'; content: string }
  | { kind: 'launched'; name: string; notes: readonly string[]; run: Promise<{ content: string; uiData?: unknown }> };

function gateMode(spec: ToolSpec, input: unknown): GateMode {
  return spec.concurrencySafe(input) ? 'read' : 'write';
}

// Join a tool's raw output with any hook-injected context/warnings, dropping
// empties so a result with no notes is byte-identical to the un-hooked path.
function compose(parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join('\n\n');
}

async function decide(callItem: PendingCall, deps: ExecDeps): Promise<Disposition> {
  const spec = deps.registry.get(callItem.name);
  if (spec === undefined) {
    return { kind: 'failed', content: `unknown tool "${callItem.name}"` };
  }

  let input: unknown;
  try {
    input = validateToolInput(spec, callItem.input);
  } catch (err) {
    if (isModelFacing(err)) return { kind: 'failed', content: err.modelText };
    throw err;
  }

  const verdict = await deps.engine.check(spec.permissionKey(input));
  let allowed: boolean;
  if (verdict === 'allow') {
    allowed = true;
  } else if (verdict === 'deny') {
    allowed = false;
  } else {
    // The engine opened an ask; the answer is the chosen option id. Anything
    // other than an explicit 'allow' is treated as a denial (fail closed).
    const answer = await verdict.ask.promise;
    allowed = answer === 'allow';
  }
  if (!allowed) {
    return { kind: 'failed', content: `permission denied for ${spec.name}` };
  }

  // PreToolUse fires only after the gate has allowed the call. A block here
  // stops the tool before it runs; allow/warn notes ride along to the result.
  const notes: string[] = [];
  if (deps.hooks !== undefined) {
    const pre = await deps.hooks.dispatch('PreToolUse', { tool: spec.name, input });
    if (pre.decision === 'block') {
      const why = pre.messages.length > 0 ? pre.messages.join('\n') : 'a PreToolUse hook blocked this call';
      return { kind: 'failed', content: why };
    }
    notes.push(...pre.contexts, ...pre.messages);
  }

  // Launch now so concurrency-safe calls overlap; the RwGate serializes writes.
  const run = deps.gate
    .run(gateMode(spec, input), () => spec.run(input, deps.ctx))
    .then((out) => ({ content: out.content, ...(out.uiData === undefined ? {} : { uiData: out.uiData }) }));
  return { kind: 'launched', name: spec.name, notes, run };
}

export async function* executeTools(
  calls: readonly PendingCall[],
  deps: ExecDeps,
): AsyncGenerator<LoopEvent, ToolResultInput[]> {
  // Phase 1 — in call order: announce, gate, and launch. Asks surface here,
  // so permission prompts are resolved before any output is collected.
  const dispositions: Disposition[] = [];
  const asksBefore = new Set(deps.engine.broker.pending().map((p) => p.askId));
  for (const c of calls) {
    yield { t: 'tool_start', callId: c.callId, name: c.name, input: c.input };
    // Surface any ask the engine opened while deciding this call. decide()
    // awaits the answer internally; we emit the event so a UI can settle it.
    const decision = decide(c, deps);
    // Drain newly-opened asks as LoopEvents before awaiting the decision.
    for (const pend of deps.engine.broker.pending()) {
      if (!asksBefore.has(pend.askId)) {
        asksBefore.add(pend.askId);
        yield { t: 'ask', askId: pend.askId, spec: pend.spec };
      }
    }
    dispositions.push(await decision);
  }

  // Phase 2 — in call order: collect outcomes, run PostToolUse, budget-fit,
  // emit tool_end.
  const results: ToolResultInput[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i] as PendingCall;
    const d = dispositions[i] as Disposition;
    let ok: boolean;
    let raw: string;
    let uiData: unknown;
    let preNotes: readonly string[] = [];
    if (d.kind === 'failed') {
      ok = false;
      raw = d.content;
    } else {
      preNotes = d.notes;
      try {
        const out = await d.run;
        ok = true;
        raw = out.content;
        uiData = out.uiData;
      } catch (err) {
        if (isModelFacing(err)) {
          ok = false;
          raw = err.modelText;
        } else if (err instanceof Error) {
          ok = false;
          raw = `tool "${c.name}" failed: ${err.message}`;
        } else {
          throw err;
        }
      }
    }

    // PostToolUse sees the tool's actual output. A block flips an already-run
    // result to failed; allow/warn notes append. Only fires for calls that ran.
    let postNotes: readonly string[] = [];
    if (deps.hooks !== undefined && d.kind === 'launched') {
      const post = await deps.hooks.dispatch('PostToolUse', { tool: d.name, ok, output: raw });
      if (post.decision === 'block') ok = false;
      postNotes = [...post.contexts, ...post.messages];
    }

    const composed = compose([...preNotes, raw, ...postNotes]);
    const fitted = await deps.budget.fit(c.callId, composed);
    results.push({ callId: c.callId, ok, content: fitted.content });
    const ui = uiData === undefined ? undefined : { kind: 'tool', data: uiData };
    yield {
      t: 'tool_end',
      callId: c.callId,
      ok,
      ...(!ok ? { name: c.name, error: fitted.content } : {}),
      ...(ui === undefined ? {} : { ui }),
    };
  }
  return results;
}
