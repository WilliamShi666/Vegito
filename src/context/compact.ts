// Compaction (DESIGN §6). Two mechanisms, both pure functions over history:
//
//   microCompact — first line of defence. The oldest tool_results (usually the
//   biggest, least relevant payloads) are replaced by short pointers to a spill
//   file. The choice is FROZEN (L2): a pointer is never re-spilled, so replay
//   is deterministic and the bytes before the newest results stay stable.
//
//   full compaction — when micro is not enough, history up to a safe boundary
//   is replaced by one structured summary. findCompactBoundary never splits a
//   tool_call/tool_result pair and always preserves a protected verbatim tail.
//   renderSummaryTemplate folds any prior summary in (iterative merge) so a
//   long session keeps exactly one running summary, not a chain of them.
//   stripScratchpad removes the model's <analysis> reasoning before injection.

import type { Block, NeutralMsg } from '../providers/types.ts';

export const MICRO_POINTER_PREFIX = '[spilled] ';

// --- boundary scan ----------------------------------------------------------

function isToolCall(block: Block | undefined): block is Extract<Block, { kind: 'tool_call' }> {
  return block?.kind === 'tool_call';
}
function isToolResult(block: Block | undefined): block is Extract<Block, { kind: 'tool_result' }> {
  return block?.kind === 'tool_result';
}

// A message "opens calls" if any block is a tool_call; "answers calls" if any
// block is a tool_result. The loop emits one call group per assistant message
// and the matching results in the next user message, so a cut is unsafe only
// when it would separate an answering message from the message that opened it.
function answersCalls(msg: NeutralMsg | undefined): boolean {
  return msg !== undefined && msg.blocks.some((b) => isToolResult(b));
}
function opensCalls(msg: NeutralMsg | undefined): boolean {
  return msg !== undefined && msg.blocks.some((b) => isToolCall(b));
}

/**
 * Index before which history may be summarised. Keeps at least `protectedTail`
 * messages verbatim and never lands between a tool_call and its tool_result.
 */
export function findCompactBoundary(history: readonly NeutralMsg[], protectedTail: number): number {
  if (history.length === 0) return 0;
  let cut = Math.max(0, history.length - protectedTail);
  // If the message at the cut answers calls opened by the message before it,
  // move the cut earlier so the pair stays together.
  while (cut > 0 && answersCalls(history[cut]) && opensCalls(history[cut - 1])) {
    cut -= 1;
  }
  return cut;
}

// --- micro-compaction -------------------------------------------------------

export interface MicroResult {
  readonly history: readonly NeutralMsg[];
  readonly spilled: number;
}

function pointerFor(block: Extract<Block, { kind: 'tool_result' }>): Block {
  return {
    kind: 'tool_result',
    callId: block.callId,
    ok: block.ok,
    content: `${MICRO_POINTER_PREFIX}tool_result ${block.callId} (${block.content.length} chars) moved to spill file`,
  };
}

function alreadySpilled(block: Extract<Block, { kind: 'tool_result' }>): boolean {
  return block.content.startsWith(MICRO_POINTER_PREFIX);
}

/** Replace the oldest up-to-`count` un-spilled tool_results with pointers. */
export function microCompact(history: readonly NeutralMsg[], count: number): MicroResult {
  if (count <= 0) return { history, spilled: 0 };
  let spilled = 0;
  const out = history.map((msg) => {
    if (spilled >= count) return msg;
    let touched = false;
    const blocks = msg.blocks.map((block) => {
      if (spilled >= count) return block;
      if (isToolResult(block) && !alreadySpilled(block)) {
        spilled += 1;
        touched = true;
        return pointerFor(block);
      }
      return block;
    });
    return touched ? { role: msg.role, blocks } : msg;
  });
  return { history: out, spilled };
}

// --- full-compaction summary ------------------------------------------------

const ANALYSIS_BLOCK = /<analysis>[\s\S]*?<\/analysis>/g;

/** Remove the model's private <analysis> scratchpad before injecting a summary. */
export function stripScratchpad(text: string): string {
  return text.replace(ANALYSIS_BLOCK, '').trim();
}

export interface SummarySections {
  readonly taskState: string;
  readonly decisions: string;
  readonly openThreads: string;
  readonly fileMap: string;
  readonly nextSteps: string;
}

/**
 * Render the structured compaction summary. `prior` (a previous summary) is
 * folded in once at the top — iterative merge keeps a single running summary.
 */
export function renderSummaryTemplate(sections: SummarySections, prior: string | undefined): string {
  const parts: string[] = [];
  if (prior !== undefined && prior.trim() !== '') {
    parts.push('## Prior summary', prior.trim(), '');
  }
  parts.push(
    '## Task state',
    sections.taskState,
    '',
    '## Decisions',
    sections.decisions,
    '',
    '## Open threads',
    sections.openThreads,
    '',
    '## File map',
    sections.fileMap,
    '',
    '## Next steps',
    sections.nextSteps,
  );
  return parts.join('\n');
}
