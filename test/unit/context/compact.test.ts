import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  findCompactBoundary,
  microCompact,
  stripScratchpad,
  renderSummaryTemplate,
  MICRO_POINTER_PREFIX,
} from '../../../src/context/compact.ts';
import type { NeutralMsg } from '../../../src/providers/types.ts';

// Helpers to build a realistic history.
const userText = (t: string): NeutralMsg => ({ role: 'user', blocks: [{ kind: 'text', text: t }] });
const asstCall = (callId: string, name: string): NeutralMsg => ({
  role: 'assistant',
  blocks: [{ kind: 'tool_call', callId, name, input: {} }],
});
const toolResult = (callId: string, content: string): NeutralMsg => ({
  role: 'user',
  blocks: [{ kind: 'tool_result', callId, ok: true, content }],
});

describe('findCompactBoundary', () => {
  test('keeps at least the protected tail of messages', () => {
    const history = [userText('1'), userText('2'), userText('3'), userText('4'), userText('5')];
    const cut = findCompactBoundary(history, 2);
    assert.equal(cut, 3); // messages [3,4] = 2 protected; cut at index 3
  });

  test('never cuts between a tool_call and its tool_result', () => {
    // A pair straddling the naive boundary must push the cut earlier.
    const history = [
      userText('start'),
      asstCall('c1', 'bash'),
      toolResult('c1', 'output'), // naive tail=2 would cut here, splitting the pair
      userText('end'),
    ];
    const cut = findCompactBoundary(history, 2);
    // The protected tail is [result, end]; cut must move before the call.
    assert.ok(cut <= 1, `cut ${cut} must not orphan the tool_result`);
  });

  test('a boundary that lands exactly between two complete pairs is kept', () => {
    const history = [
      asstCall('c1', 'a'),
      toolResult('c1', 'x'),
      asstCall('c2', 'b'),
      toolResult('c2', 'y'),
    ];
    const cut = findCompactBoundary(history, 2);
    assert.equal(cut, 2); // keep the [c2 call, c2 result] pair intact
  });

  test('protecting more than the whole history yields cut 0', () => {
    const history = [userText('1'), userText('2')];
    assert.equal(findCompactBoundary(history, 10), 0);
  });

  test('empty history yields cut 0', () => {
    assert.equal(findCompactBoundary([], 2), 0);
  });
});

describe('microCompact', () => {
  test('replaces the oldest tool_result content with a pointer, keeps the rest', () => {
    const history = [
      asstCall('c1', 'bash'),
      toolResult('c1', 'a very long output that should spill'),
      asstCall('c2', 'grep'),
      toolResult('c2', 'recent output kept verbatim'),
    ];
    const { history: out, spilled } = microCompact(history, 1);
    assert.equal(spilled, 1);
    const firstResult = out[1]?.blocks[0];
    assert.equal(firstResult?.kind, 'tool_result');
    if (firstResult?.kind === 'tool_result') {
      assert.ok(firstResult.content.startsWith(MICRO_POINTER_PREFIX));
      assert.match(firstResult.content, /c1/); // pointer references the call id
    }
    // Recent result untouched.
    const lastResult = out[3]?.blocks[0];
    if (lastResult?.kind === 'tool_result') {
      assert.equal(lastResult.content, 'recent output kept verbatim');
    }
  });

  test('the choice is frozen: a pointer is never re-spilled', () => {
    const history = [asstCall('c1', 'bash'), toolResult('c1', 'orig')];
    const once = microCompact(history, 1).history;
    const twice = microCompact(once, 1);
    assert.equal(twice.spilled, 0); // already a pointer
    assert.deepEqual(twice.history, once);
  });

  test('spills up to the requested count, oldest first', () => {
    const history = [
      toolResult('c1', 'first'),
      toolResult('c2', 'second'),
      toolResult('c3', 'third'),
    ];
    const { history: out, spilled } = microCompact(history, 2);
    assert.equal(spilled, 2);
    assert.ok((out[0]?.blocks[0] as { content: string }).content.startsWith(MICRO_POINTER_PREFIX));
    assert.ok((out[1]?.blocks[0] as { content: string }).content.startsWith(MICRO_POINTER_PREFIX));
    assert.equal((out[2]?.blocks[0] as { content: string }).content, 'third'); // newest kept
  });

  test('preserves the call id and ok flag in the pointer block', () => {
    const history = [{ role: 'user', blocks: [{ kind: 'tool_result', callId: 'c9', ok: false, content: 'err' }] } as NeutralMsg];
    const out = microCompact(history, 1).history;
    const b = out[0]?.blocks[0];
    assert.equal(b?.kind, 'tool_result');
    if (b?.kind === 'tool_result') {
      assert.equal(b.callId, 'c9');
      assert.equal(b.ok, false);
    }
  });
});

describe('stripScratchpad', () => {
  test('removes a single <analysis>...</analysis> block', () => {
    const text = 'before<analysis>secret reasoning</analysis>after';
    assert.equal(stripScratchpad(text), 'beforeafter');
  });

  test('removes multiple analysis blocks and trims', () => {
    const text = '<analysis>a</analysis>keep<analysis>b</analysis>';
    assert.equal(stripScratchpad(text), 'keep');
  });

  test('handles multiline analysis blocks', () => {
    const text = 'summary\n<analysis>\nline1\nline2\n</analysis>\ndone';
    assert.match(stripScratchpad(text), /summary/);
    assert.doesNotMatch(stripScratchpad(text), /line1/);
    assert.match(stripScratchpad(text), /done/);
  });

  test('text without analysis is returned unchanged (trimmed)', () => {
    assert.equal(stripScratchpad('  plain summary  '), 'plain summary');
  });
});

describe('renderSummaryTemplate', () => {
  const sections = {
    taskState: 'Building P5.',
    decisions: 'T2 frozen at boot.',
    openThreads: 'compact.ts in progress.',
    fileMap: 'src/context/*.ts',
    nextSteps: 'wire into loop.',
  };

  test('includes every section under a labelled heading', () => {
    const out = renderSummaryTemplate(sections, undefined);
    assert.match(out, /Building P5\./);
    assert.match(out, /T2 frozen at boot\./);
    assert.match(out, /compact\.ts in progress\./);
    assert.match(out, /src\/context\/\*\.ts/);
    assert.match(out, /wire into loop\./);
  });

  test('iterative merge: a prior summary is folded in, not duplicated', () => {
    const prior = 'Earlier: P0-P4 done.';
    const out = renderSummaryTemplate(sections, prior);
    assert.match(out, /P0-P4 done\./);
    assert.match(out, /Building P5\./);
    // The prior summary appears once.
    assert.equal(out.split('P0-P4 done.').length - 1, 1);
  });

  test('omitting a prior summary produces a standalone summary', () => {
    const out = renderSummaryTemplate(sections, undefined);
    assert.doesNotMatch(out, /Earlier:/);
  });
});
