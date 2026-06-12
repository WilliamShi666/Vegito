// The kernel (DESIGN §3, D2): event algebra, immutable state + pure reducer,
// command queue, the recovery ladder, the tool-execution stage, and the
// runTurn generator that composes them into one deterministic turn.
export * from './events.ts';
export * from './errors.ts';
export * from './state.ts';
export * from './reducer.ts';
export * from './queue.ts';
export * from './recovery.ts';
export { executeTools, type ExecDeps } from './executor.ts';
export { runTurn, type LoopDeps, type TurnResult } from './loop.ts';
