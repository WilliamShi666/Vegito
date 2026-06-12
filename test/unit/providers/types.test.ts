import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { ZERO_USAGE, addUsage, type Usage, type NeutralMsg, type ProviderEvent } from '../../../src/providers/types.ts';

describe('usage arithmetic', () => {
  test('ZERO_USAGE is all zeros and frozen', () => {
    assert.deepEqual(ZERO_USAGE, { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    assert.ok(Object.isFrozen(ZERO_USAGE));
  });

  test('addUsage sums componentwise without mutating inputs', () => {
    const a: Usage = { in: 10, out: 5, cacheRead: 100, cacheWrite: 7 };
    const b: Usage = { in: 1, out: 2, cacheRead: 3, cacheWrite: 4 };
    const sum = addUsage(a, b);
    assert.deepEqual(sum, { in: 11, out: 7, cacheRead: 103, cacheWrite: 11 });
    assert.deepEqual(a, { in: 10, out: 5, cacheRead: 100, cacheWrite: 7 });
    assert.notEqual(sum, a);
  });

  test('addUsage with ZERO_USAGE is identity-valued', () => {
    const a: Usage = { in: 3, out: 1, cacheRead: 0, cacheWrite: 2 };
    assert.deepEqual(addUsage(a, ZERO_USAGE), a);
  });
});

describe('neutral message algebra (type-level, exercised at runtime)', () => {
  test('a message with every block kind is JSON-serializable', () => {
    const msg: NeutralMsg = {
      role: 'assistant',
      blocks: [
        { kind: 'text', text: 'hello' },
        { kind: 'thinking', text: 'hmm', sig: 'abc' },
        { kind: 'tool_call', callId: 'c1', name: 'read', input: { path: '/x' } },
        { kind: 'tool_result', callId: 'c1', ok: true, content: 'data' },
        { kind: 'image', mediaType: 'image/png', dataBase64: 'aGk=' },
      ],
    };
    assert.deepEqual(JSON.parse(JSON.stringify(msg)), msg);
  });

  test('provider events round-trip through JSON', () => {
    const events: ProviderEvent[] = [
      { t: 'msg_start', model: 'scripted-1' },
      { t: 'text_delta', text: 'par' },
      { t: 'thinking_delta', text: 'consider…' },
      { t: 'tool_call', callId: 'c9', name: 'bash', input: { cmd: 'ls' } },
      { t: 'msg_end', stop: 'tool_use', usage: { in: 1, out: 2, cacheRead: 0, cacheWrite: 0 } },
    ];
    assert.deepEqual(JSON.parse(JSON.stringify(events)), events);
  });
});
