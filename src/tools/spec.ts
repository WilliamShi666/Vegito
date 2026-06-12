// ToolSpec (DESIGN §7.1, D5): the contract every tool — builtin, MCP, pack —
// satisfies. TOOL_DEFAULTS are fail-closed: a tool is write-class, serial,
// and ask-gated until its author explicitly declares otherwise (cc/02).

import type { JsonSchema } from '../lib/jsonschema.ts';
import type { FileState } from '../context/filestate.ts';

export type PermAction = 'read' | 'write' | 'execute' | 'network';

/** What the single permission gate (P4) evaluates. Neutral, serializable. */
export interface PermKey {
  readonly tool: string;
  readonly action: PermAction;
  readonly target?: string;
}

export type Exposure = 'direct' | 'deferred' | 'hidden';

export interface ToolCtx {
  readonly cwd: string;
  readonly signal: AbortSignal;
  /** Session file-freshness ledger: read notes it, write/edit consult it. */
  readonly files: FileState;
}

export interface ToolOut {
  readonly content: string;
  /** Serializable hints for UIs; tools never render (A4). */
  readonly uiData?: unknown;
}

export interface ToolSpec<In = unknown> {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonSchema;
  readonly exposure: Exposure;
  /** L4 partition predicate: true = may run alongside other safe calls. */
  concurrencySafe(input: In): boolean;
  /** Every tool call routes through the single gate via this key. */
  permissionKey(input: In): PermKey;
  run(input: In, ctx: ToolCtx): Promise<ToolOut>;
}

export interface ToolSpecInit<In> {
  name: string;
  description: string;
  schema: JsonSchema;
  exposure?: Exposure;
  concurrencySafe?: (input: In) => boolean;
  permissionKey?: (input: In) => PermKey;
  run(input: In, ctx: ToolCtx): Promise<ToolOut>;
}

export function defineTool<In = unknown>(init: ToolSpecInit<In>): ToolSpec<In> {
  return {
    name: init.name,
    description: init.description,
    schema: init.schema,
    exposure: init.exposure ?? 'direct',
    concurrencySafe: init.concurrencySafe ?? (() => false),
    permissionKey: init.permissionKey ?? (() => ({ tool: init.name, action: 'write' })),
    run: init.run,
  };
}
