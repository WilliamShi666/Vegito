// Two-tier error taxonomy (DESIGN §3.4, L9): model-facing failures become
// tool_result blocks the model can self-repair from; fatal failures carry a
// typed ExitReason and end the turn.

import type { Block } from '../providers/types.ts';
import type { ExitReason } from './events.ts';

type ToolResultBlock = Extract<Block, { kind: 'tool_result' }>;

export class ModelFacingError extends Error {
  readonly modelText: string;

  constructor(modelText: string, options?: { cause?: unknown }) {
    super(modelText, options);
    this.name = 'ModelFacingError';
    this.modelText = modelText;
  }

  toToolResult(callId: string): ToolResultBlock {
    return { kind: 'tool_result', callId, ok: false, content: this.modelText };
  }
}

export class FatalError extends Error {
  readonly reason: ExitReason;

  constructor(reason: ExitReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FatalError';
    this.reason = reason;
  }
}

export function isModelFacing(err: unknown): err is ModelFacingError {
  return err instanceof ModelFacingError;
}

export function isFatal(err: unknown): err is FatalError {
  return err instanceof FatalError;
}
