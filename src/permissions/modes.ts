// Permission modes (DESIGN §7.2): the four operator-selected stances, frozen
// at boot. The mode is captured once into an immutable value the engine holds
// as a private const; in-process code cannot widen it afterward (the hermes
// invariant — no tool, pack, or agent can escalate its own privilege).
//
//   default     — rules decide; unmatched write/execute/network ask.
//   acceptEdits — in-workspace writes auto-allow; everything else as default.
//   plan        — read-only: any non-read action is denied outright.
//   bypass      — skip the rule tables (the floor still applies, always).

import type { PermissionMode } from '../config/schema.ts';

export type FrozenMode = PermissionMode;

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

/** Validate a requested mode and return it as an immutable literal. */
export function freezeMode(requested: PermissionMode): FrozenMode {
  if (!MODES.includes(requested)) {
    throw new Error(`unknown permission mode: ${String(requested)}`);
  }
  return requested;
}

/** plan mode: any action other than 'read' is denied. */
export function deniesNonReadActions(mode: FrozenMode): boolean {
  return mode === 'plan';
}

/** acceptEdits: write-action keys whose target is inside the workspace allow. */
export function allowsWritesInWorkspace(mode: FrozenMode): boolean {
  return mode === 'acceptEdits';
}

/** bypass: the configurable rule tables are skipped (the floor is not). */
export function bypassesRules(mode: FrozenMode): boolean {
  return mode === 'bypass';
}
