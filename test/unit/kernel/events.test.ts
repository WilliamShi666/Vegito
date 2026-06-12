import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { EXIT_REASONS, type ExitReason, type LoopEvent } from '../../../src/kernel/events.ts';

describe('exit reasons', () => {
  test('covers the seven DESIGN §3.1 reasons, no duplicates', () => {
    assert.deepEqual(
      [...EXIT_REASONS].sort(),
      ['awaiting_input', 'budget_tokens', 'denial_breaker', 'end_turn', 'fatal_error', 'interrupted', 'max_iterations'],
    );
    assert.equal(new Set(EXIT_REASONS).size, EXIT_REASONS.length);
  });
});

describe('loop events', () => {
  // One literal per variant. If a variant is added to LoopEvent without a
  // sample here, the exhaustiveness check below fails to compile.
  const samples: LoopEvent[] = [
    { t: 'turn_start', turn: 3 },
    { t: 'model_call', provider: 'anthropic', model: 'claude-fable-5', attempt: 1 },
    { t: 'text_delta', text: 'hello' },
    { t: 'thinking_delta', text: 'pondering' },
    { t: 'tool_start', callId: 'c1', name: 'read', input: { path: 'a.ts' } },
    { t: 'tool_end', callId: 'c1', ok: true, ui: { kind: 'text', data: '12 lines' } },
    {
      t: 'ask',
      askId: 'a1',
      spec: { kind: 'permission', title: 'Run `rm -rf dist`?', options: [{ id: 'yes', label: 'Allow' }, { id: 'no', label: 'Deny' }] },
    },
    { t: 'context', used: 1200, budget: 200000 },
    { t: 'compaction', kind: 'micro' },
    { t: 'notice', level: 'warn', text: 'failover: hop to backup model' },
    { t: 'turn_end', reason: 'end_turn', usage: { in: 10, out: 20, cacheRead: 5, cacheWrite: 0 } },
  ];

  test('every variant is represented exactly once', () => {
    const tags = samples.map((e) => e.t);
    assert.equal(new Set(tags).size, tags.length);
    const expected: Record<LoopEvent['t'], true> = {
      turn_start: true,
      model_call: true,
      text_delta: true,
      thinking_delta: true,
      tool_start: true,
      tool_end: true,
      ask: true,
      context: true,
      compaction: true,
      notice: true,
      turn_end: true,
    };
    assert.deepEqual([...tags].sort(), Object.keys(expected).sort());
  });

  test('every event JSON round-trips losslessly (D11: one stream drives all UIs)', () => {
    for (const ev of samples) {
      assert.deepEqual(JSON.parse(JSON.stringify(ev)), ev, ev.t);
    }
  });

  test('turn_end reasons are constrained to ExitReason', () => {
    const reason: ExitReason = 'denial_breaker';
    const ev: LoopEvent = { t: 'turn_end', reason, usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } };
    assert.ok(EXIT_REASONS.includes(ev.reason));
  });
});
