// Tools layer barrel (DESIGN §7): the public surface. Core pipeline pieces
// (spec/registry/gate/budget) plus the launch builtin set. Stateless builtins
// are shared consts; stateful ones are constructed per session here so no
// state leaks across sessions.

import type { ToolSpec } from './spec.ts';
import { makeAgentTool } from './builtin/agent.ts';
import type { AgentToolDeps } from './builtin/agent.ts';
import { makeBashTools } from './builtin/bash.ts';
import { editTool } from './builtin/edit.ts';
import { makeFetchTool } from './builtin/fetch.ts';
import type { FetchOpts } from './builtin/fetch.ts';
import { globTool } from './builtin/glob.ts';
import { grepTool } from './builtin/grep.ts';
import { lsTool } from './builtin/ls.ts';
import { makeMemoryTool } from './builtin/memory.ts';
import { readTool } from './builtin/read.ts';
import { makeSkillTool } from './builtin/skill.ts';
import type { SkillSource } from './builtin/skill.ts';
import { makeTodoTool } from './builtin/todo.ts';
import { writeTool } from './builtin/write.ts';

export { defineTool } from './spec.ts';
export type { Exposure, PermAction, PermKey, ToolCtx, ToolOut, ToolSpec, ToolSpecInit } from './spec.ts';
export { validateToolInput } from './validate.ts';
export { ToolRegistry } from './registry.ts';
export { RwGate } from './gate.ts';
export { DEFAULT_BUDGET, MessageBudget, SpillStore, truncateMiddle } from './budget.ts';
export type { BudgetPolicy, FitResult } from './budget.ts';

export { readTool } from './builtin/read.ts';
export { writeTool } from './builtin/write.ts';
export { editTool } from './builtin/edit.ts';
export { lsTool } from './builtin/ls.ts';
export { globTool } from './builtin/glob.ts';
export { grepTool } from './builtin/grep.ts';
export { makeBashTools } from './builtin/bash.ts';
export type { BashTools } from './builtin/bash.ts';
export { makeTodoTool } from './builtin/todo.ts';
export type { TodoItem, TodoStatus, TodoTool } from './builtin/todo.ts';
export { isPrivateAddress, makeFetchTool } from './builtin/fetch.ts';
export type { FetchOpts } from './builtin/fetch.ts';
export { makeMemoryTool } from './builtin/memory.ts';
export { makeSkillTool } from './builtin/skill.ts';
export type { SkillMeta, SkillSource } from './builtin/skill.ts';
export { makeAgentTool } from './builtin/agent.ts';
export type { AgentIn, AgentToolDeps } from './builtin/agent.ts';

export interface BuiltinDeps {
  /** Directory for the persistent memory store. */
  readonly memoryDir: string;
  /** Skill catalog (P8's registry implements this from disk). */
  readonly skills: SkillSource;
  readonly fetchOpts?: FetchOpts;
  /**
   * Multi-agent wiring (P9). When present, the `agent` tool is constructed and
   * exposed; the session layer supplies a Spawner whose runChild re-enters the
   * loop. Absent ⇒ no spawning surface in this session.
   */
  readonly agent?: AgentToolDeps;
}

export interface BuiltinSet {
  readonly tools: readonly ToolSpec[];
  /** Session teardown: kills lingering background bash jobs. */
  dispose(): void;
}

export function makeBuiltinTools(deps: BuiltinDeps): BuiltinSet {
  const bash = makeBashTools();
  const tools: ToolSpec[] = [
    readTool,
    writeTool,
    editTool,
    lsTool,
    globTool,
    grepTool,
    bash.bashTool,
    bash.bashOutputTool,
    makeTodoTool(),
    makeFetchTool(deps.fetchOpts),
    makeMemoryTool(deps.memoryDir),
    makeSkillTool(deps.skills),
  ];
  if (deps.agent) tools.push(makeAgentTool(deps.agent));
  return { tools, dispose: () => bash.dispose() };
}
