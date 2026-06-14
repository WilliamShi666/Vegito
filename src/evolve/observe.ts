import type { NeutralMsg } from '../providers/types.ts';
import { validateRawObservation, type Observation, type RawObservation } from './types.ts';

// observe (DESIGN §8): a forked-child session reviews a transcript and emits
// typed Observations. The review itself is a model call (or a scripted fixture
// in tests) injected as `Reviewer`; observe()'s own job is deterministic —
// render the transcript, hand it over, then stamp each raw observation with a
// stable id (`<sid>#<index>`) and the originating sid. Mirrors the memory
// extractor's split: the model classifies, the engine accounts.

export type Reviewer = (transcript: string) => Promise<readonly RawObservation[]>;

function messageText(msg: NeutralMsg): string {
  return msg.blocks
    .map((b) =>
      b.kind === 'text' || b.kind === 'thinking'
        ? b.text
        : b.kind === 'tool_result'
          ? b.content
          : '',
    )
    .filter((s) => s !== '')
    .join('\n');
}

function renderTranscript(messages: readonly NeutralMsg[]): string {
  return messages.map((m) => `[${m.role}] ${messageText(m)}`).join('\n');
}

export async function observe(
  sid: string,
  messages: readonly NeutralMsg[],
  reviewer: Reviewer,
): Promise<readonly Observation[]> {
  // Nothing to review: skip the model call entirely (cheap, idempotent).
  if (messages.length === 0) return [];

  const raws = await reviewer(renderTranscript(messages));
  const out: Observation[] = [];
  for (let i = 0; i < raws.length; i++) {
    const raw = raws[i]!;
    // Defensive: a model can hand back a malformed shape. Drop anything whose
    // kind we don't recognize rather than letting it poison downstream stages.
    const validated = validateRawObservation(raw);
    if (!validated.ok) continue;
    out.push({ ...validated.value, id: `${sid}#${i}`, sid });
  }
  return out;
}
