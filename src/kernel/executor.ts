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

// The tool execution stage (DESIGN §3.2, §7.1, L4). Drives the model's
// pending tool calls through the pipeline: validate → permission gate (which
// may surface an `ask`) → partition (concurrency-safe reads parallelize, writes
// run exclusively via the RwGate) → run → output budget. It is an async
// generator: it *yields* LoopEvents (tool_start, ask, tool_end) for any UI and
// *returns* the ToolResultInput[] the reducer folds back into history.
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
}

type Disposition =
  | { kind: 'failed'; content: string }
  | { kind: 'launched'; run: Promise<{ content: string; uiData?: unknown }> };

function gateMode(spec: ToolSpec, input: unknown): GateMode {
  return spec.concurrencySafe(input) ? 'read' : 'write';
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

  // Launch now so concurrency-safe calls overlap; the RwGate serializes writes.
  const run = deps.gate
    .run(gateMode(spec, input), () => spec.run(input, deps.ctx))
    .then((out) => ({ content: out.content, ...(out.uiData === undefined ? {} : { uiData: out.uiData }) }));
  return { kind: 'launched', run };
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

  // Phase 2 — in call order: collect outcomes, budget-fit, emit tool_end.
  const results: ToolResultInput[] = [];
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i] as PendingCall;
    const d = dispositions[i] as Disposition;
    let ok: boolean;
    let raw: string;
    let uiData: unknown;
    if (d.kind === 'failed') {
      ok = false;
      raw = d.content;
    } else {
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
    const fitted = await deps.budget.fit(c.callId, raw);
    results.push({ callId: c.callId, ok, content: fitted.content });
    const ui = uiData === undefined ? undefined : { kind: 'tool', data: uiData };
    yield { t: 'tool_end', callId: c.callId, ok, ...(ui === undefined ? {} : { ui }) };
  }
  return results;
}
