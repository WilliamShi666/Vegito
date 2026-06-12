// Public surface of the permission layer. The engine is the single gate; the
// rest are its composable parts, exported for tests and for the loop/UI that
// settle asks. Nothing here talks to a terminal — verdicts and asks only.

export { createEngine } from './engine.ts';
export type { Engine, EngineOptions, CheckResult } from './engine.ts';

export { analyzeShell } from './shell.ts';
export type { ShellCommand, ShellAnalysis } from './shell.ts';

export { resolveWithin } from './paths.ts';
export type { ResolvedPath } from './paths.ts';

export { matchRules, floorCheck } from './rules.ts';
export type { Rule, Verdict, FloorHit } from './rules.ts';

export { freezeMode, deniesNonReadActions, allowsWritesInWorkspace, bypassesRules } from './modes.ts';
export type { FrozenMode } from './modes.ts';

export { createDeferred, createAskBroker } from './ask.ts';
export type { Deferred, AskBroker, OpenAsk, PendingAsk } from './ask.ts';
