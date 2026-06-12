import { test } from 'node:test';
import assert from 'node:assert/strict';

import { enrichSpec } from '../../../src/forge/enrich.ts';
import { getArchetype } from '../../../src/forge/templates/index.ts';
import type { CallModel } from '../../../src/ui/runtime.ts';
import type { ProviderEvent } from '../../../src/providers/types.ts';

function scriptedReply(text: string): CallModel {
  return async function* (): AsyncIterable<ProviderEvent> {
    yield { t: 'msg_start', model: 'scripted' };
    yield { t: 'text_delta', text };
    yield { t: 'msg_end', stop: 'end_turn', usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } };
  };
}

const spec = getArchetype('tutor-team')({ domain: 'IELTS writing' });

test('enrichSpec replaces the persona with the model rewrite', async () => {
  const out = await enrichSpec(spec, scriptedReply('A sharper, domain-specific persona.'), new AbortController().signal);
  assert.equal(out.persona, 'A sharper, domain-specific persona.');
  // everything else is preserved.
  assert.deepEqual(out.agents, spec.agents);
});

test('enrichSpec keeps the template persona when the rewrite is empty', async () => {
  const out = await enrichSpec(spec, scriptedReply('   '), new AbortController().signal);
  assert.equal(out.persona, spec.persona);
});

test('enrichSpec rejects an over-constrained rewrite and keeps the template', async () => {
  const overBudget = ['Do not lie.', 'Never guess.', "Don't stall.", 'Avoid fluff.', 'No hedging.', 'Do not ramble.'].join('\n');
  const out = await enrichSpec(spec, scriptedReply(overBudget), new AbortController().signal);
  assert.equal(out.persona, spec.persona);
});

test('enrichSpec falls back to the template when the call throws', async () => {
  const failing: CallModel = async function* (): AsyncIterable<ProviderEvent> {
    throw new Error('provider down');
  };
  const out = await enrichSpec(spec, failing, new AbortController().signal);
  assert.equal(out.persona, spec.persona);
});
