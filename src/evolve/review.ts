import type { CallModel } from '../ui/runtime.ts';
import type { NeutralRequest } from '../providers/types.ts';
import type { Reviewer } from './observe.ts';
import { OBSERVATION_KINDS, type RawObservation } from './types.ts';

// The reviewer (DESIGN §8): a bounded model call that reads a session
// transcript and emits raw observations as JSON. observe() handles id/sid
// stamping and validation; this module owns the prompt, the token bound, and
// defensive parsing. A model that finds nothing — or replies in prose — yields
// no observations rather than an error, so a no-op review is always safe.

const REVIEW_SYSTEM = [
  'You review an agent session transcript and report what the agent team could',
  'learn from it. Reply with a JSON array (no prose, no fences) of observations.',
  'Each observation is one of:',
  '  {"kind":"friction","summary":"...","constraint":"one imperative line"}',
  '  {"kind":"rubric_drift","summary":"...","rubric":"Rubric Name","guidance":"..."}',
  '  {"kind":"missing_skill","summary":"...","skill":"skill-id"}',
  '  {"kind":"memory_candidate","summary":"...","fact":"...","level":"l1|l2|l3"}',
  'Report only durable, reusable lessons. If nothing is worth keeping, reply [].',
].join('\n');

const MAX_REVIEW_TOKENS = 2048;

// Strip a leading ```json / ``` fence if the model wrapped its reply.
function unfence(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text.trim());
  return fenced ? fenced[1]!.trim() : text.trim();
}

function parseRaws(text: string): readonly RawObservation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(text));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RawObservation[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const kind = (item as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !(OBSERVATION_KINDS as readonly string[]).includes(kind)) continue;
    out.push(item as RawObservation);
  }
  return out;
}

async function collectText(callModel: CallModel, req: NeutralRequest, signal: AbortSignal): Promise<string> {
  let text = '';
  for await (const ev of callModel(req, signal)) {
    if (ev.t === 'text_delta') text += ev.text;
  }
  return text;
}

export function buildReviewer(callModel: CallModel, signal: AbortSignal, model = 'tier:smart'): Reviewer {
  return async (transcript: string): Promise<readonly RawObservation[]> => {
    const req: NeutralRequest = {
      model,
      system: [REVIEW_SYSTEM],
      messages: [{ role: 'user', blocks: [{ kind: 'text', text: transcript }] }],
      tools: [],
      maxTokens: MAX_REVIEW_TOKENS,
    };
    let text: string;
    try {
      text = await collectText(callModel, req, signal);
    } catch {
      return [];
    }
    return parseRaws(text);
  };
}
