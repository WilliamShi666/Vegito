// Forge enrichment (DESIGN §10). The offline path emits a complete, valid pack
// from templates alone. The online path adds one bounded model call that
// rewrites the *persona* to the specific domain — the highest-leverage prose in
// the pack — and nothing else, keeping the model's surface small and the result
// auditable. The rewrite is re-validated against the constraint budget; if it
// regresses (over budget) or the call fails, we keep the template persona. The
// model can improve the pack, never break it.

import type { CallModel } from '../ui/runtime.ts';
import type { ForgeSpec } from './spec.ts';
import { countNegativeConstraints, MAX_NEGATIVE_CONSTRAINTS } from '../extend/pack-validate.ts';
import type { NeutralRequest } from '../providers/types.ts';

const ENRICH_SYSTEM = [
  'You refine a pack persona for a domain agent team. Rewrite the given persona so',
  'it is concrete and specific to the stated domain, keeping the same intent and a',
  'similar length. Reply with the rewritten persona only — no preamble, no fences.',
].join('\n');

/** Collect the assistant text from one non-streaming-style provider exchange. */
async function collectText(callModel: CallModel, req: NeutralRequest, signal: AbortSignal): Promise<string> {
  let text = '';
  for await (const ev of callModel(req, signal)) {
    if (ev.t === 'text_delta') text += ev.text;
  }
  return text.trim();
}

/**
 * Return a spec whose persona has been rewritten for the domain, or the original
 * spec unchanged if enrichment is unavailable or would regress the constraint
 * budget. Pure except for the injected model call.
 */
export async function enrichSpec(
  spec: ForgeSpec,
  callModel: CallModel,
  signal: AbortSignal,
  model = 'tier:smart',
): Promise<ForgeSpec> {
  const req: NeutralRequest = {
    model,
    system: [ENRICH_SYSTEM],
    messages: [
      {
        role: 'user',
        blocks: [
          {
            kind: 'text',
            text: `Domain: ${spec.description}\n\nPersona to refine:\n${spec.persona}`,
          },
        ],
      },
    ],
    tools: [],
    maxTokens: 1024,
  };

  let rewritten: string;
  try {
    rewritten = await collectText(callModel, req, signal);
  } catch {
    return spec;
  }
  if (rewritten === '' || countNegativeConstraints(rewritten) > MAX_NEGATIVE_CONSTRAINTS) {
    return spec;
  }
  return { ...spec, persona: rewritten };
}
