// P10 renderer (DESIGN §11): a pure fold from LoopEvent → display Frame. The
// renderer never touches a terminal and holds no state — the REPL appends the
// frames it returns, headless text mode prints them, and `--json` skips it
// entirely. Per-event mapping is the whole contract; channels let a UI style
// without re-parsing. Tools never render (A4): the executor hands us only the
// neutral ToolUIData side channel, and we show a compact preview, never invoke
// tool code.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { renderEvent } from '../../../src/ui/render.ts';
import type { LoopEvent } from '../../../src/kernel/events.ts';

const usage = { in: 10, out: 5, cacheRead: 0, cacheWrite: 0 };

describe('renderEvent', () => {
  test('streams assistant text verbatim on the text channel', () => {
    const f = renderEvent({ t: 'text_delta', text: 'hello world' });
    assert.deepEqual(f, { channel: 'text', text: 'hello world' });
  });

  test('routes thinking to its own channel', () => {
    const f = renderEvent({ t: 'thinking_delta', text: 'let me think' });
    assert.equal(f?.channel, 'thinking');
    assert.equal(f?.text, 'let me think');
  });

  test('tool_start shows the tool name and a compact input', () => {
    const f = renderEvent({ t: 'tool_start', callId: 'c1', name: 'read', input: { path: 'a.ts' } });
    assert.equal(f?.channel, 'tool');
    assert.match(f!.text, /read/);
    assert.match(f!.text, /a\.ts/);
  });

  test('tool_end marks success and failure distinctly', () => {
    const ok = renderEvent({ t: 'tool_end', callId: 'c1', ok: true });
    const bad = renderEvent({ t: 'tool_end', callId: 'c2', ok: false });
    assert.equal(ok?.channel, 'tool');
    assert.notEqual(ok!.text, bad!.text);
    assert.match(bad!.text, /c2/);
  });

  test('failed tool_end renders concise user-facing error detail', () => {
    const f = renderEvent({
      t: 'tool_end',
      callId: 'c1',
      ok: false,
      name: 'skill',
      error: 'no skill named "gitnexus-exploring" — available: (none)',
    });

    assert.equal(f?.channel, 'tool');
    assert.match(f!.text, /Tool failed: skill/);
    assert.match(f!.text, /no skill named "gitnexus-exploring"/);
    assert.doesNotMatch(f!.text, /ModelFacingError|at Object\.run|\.js:\d+/);
  });

  test('an ask renders its title and option labels', () => {
    const f = renderEvent({
      t: 'ask',
      askId: 'a1',
      spec: { kind: 'permission', title: 'Allow write to a.ts?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }] },
    });
    assert.equal(f?.channel, 'ask');
    assert.match(f!.text, /Allow write to a\.ts\?/);
    assert.match(f!.text, /Yes/);
    assert.match(f!.text, /No/);
  });

  test('a permission ask renders as a distinct permission frame', () => {
    const f = renderEvent({
      t: 'ask',
      askId: 'a1',
      spec: {
        kind: 'permission',
        title: 'Allow ls (read): /workspace?',
        tool: 'ls',
        action: 'read',
        target: '/workspace',
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
      },
    });

    assert.equal(f?.channel, 'ask');
    assert.match(f!.text, /^Permission request/m);
    assert.match(f!.text, /Tool: ls/);
    assert.match(f!.text, /Action: read/);
    assert.match(f!.text, /Target: \/workspace/);
    assert.match(f!.text, /\[a\] allow/);
    assert.match(f!.text, /\[d\] deny/);
    assert.match(f!.text, /permission>/);
    assert.doesNotMatch(f!.text, /vegito>/);
  });

  test('queued permission asks include deterministic progress when provided', () => {
    const f = renderEvent({
      t: 'ask',
      askId: 'a2',
      spec: {
        kind: 'permission',
        title: 'Allow write?',
        tool: 'write',
        action: 'write',
        options: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
        ordinal: 2,
        total: 3,
      },
    });

    assert.match(f?.text ?? '', /Permission 2\/3/);
  });

  test('notices carry their level', () => {
    const warn = renderEvent({ t: 'notice', level: 'warn', text: 'rate limited' });
    assert.equal(warn?.channel, 'notice');
    assert.match(warn!.text, /warn/i);
    assert.match(warn!.text, /rate limited/);
  });

  test('compaction is surfaced as meta', () => {
    const f = renderEvent({ t: 'compaction', kind: 'full' });
    assert.equal(f?.channel, 'meta');
    assert.match(f!.text, /compact/i);
  });

  test('turn_end reports the exit reason and token usage', () => {
    const f = renderEvent({ t: 'turn_end', reason: 'end_turn', usage });
    assert.equal(f?.channel, 'meta');
    assert.match(f!.text, /end_turn/);
    assert.match(f!.text, /10/);
    assert.match(f!.text, /5/);
  });

  test('a retried model call is surfaced; the first attempt is silent', () => {
    assert.equal(renderEvent({ t: 'model_call', provider: 'anthropic', model: 'm', attempt: 1 }), null);
    const retry = renderEvent({ t: 'model_call', provider: 'anthropic', model: 'm', attempt: 2 });
    assert.equal(retry?.channel, 'meta');
    assert.match(retry!.text, /retr|attempt|2/i);
  });

  test('turn_start and context are non-visible (null) frames', () => {
    assert.equal(renderEvent({ t: 'turn_start', turn: 0 }), null);
    assert.equal(renderEvent({ t: 'context', used: 100, budget: 1000 }), null);
  });

  const allEvents: LoopEvent[] = [
    { t: 'turn_start', turn: 0 },
    { t: 'model_call', provider: 'p', model: 'm', attempt: 1 },
    { t: 'text_delta', text: 'x' },
    { t: 'thinking_delta', text: 'y' },
    { t: 'tool_start', callId: 'c', name: 'n', input: {} },
    { t: 'tool_end', callId: 'c', ok: true },
    { t: 'ask', askId: 'a', spec: { kind: 'input', title: 't' } },
    { t: 'context', used: 1, budget: 2 },
    { t: 'compaction', kind: 'micro' },
    { t: 'notice', level: 'info', text: 'i' },
    { t: 'turn_end', reason: 'max_iterations', usage },
  ];

  test('every LoopEvent variant maps without throwing', () => {
    for (const ev of allEvents) {
      const f = renderEvent(ev);
      assert.ok(f === null || (typeof f.text === 'string' && typeof f.channel === 'string'));
    }
  });
});
