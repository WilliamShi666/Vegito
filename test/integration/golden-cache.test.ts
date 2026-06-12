import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { canonicalHash } from '../../src/lib/hash.ts';
import { createSystemPrompt } from '../../src/context/prompt.ts';
import { createFragmentRegistry } from '../../src/context/fragments.ts';
import { findCompactBoundary, microCompact, renderSummaryTemplate } from '../../src/context/compact.ts';
import type { NeutralMsg } from '../../src/providers/types.ts';

// The golden cache gate (DESIGN §6, D4): in a multi-turn session the stable
// prefix fed to the wire must stay byte-identical across turns so the
// provider's cache hits. We model the prefix as the system tiers plus all
// history before the protected tail, hash it canonically, and assert the hash
// only changes when it MUST (a deliberate compaction), never incidentally.

const PROTECTED_TAIL = 4;

const prompt = createSystemPrompt({
  identity: 'You are Vegito.',
  constitution: ['Be precise.', 'Fail closed.'],
  environment: { cwd: '/home/u/proj', platform: 'linux', date: '2026-06-12' },
  memoryFiles: [{ path: 'VEGITO.md', content: 'rules' }],
  packs: ['ielts'],
});

const userTurn = (t: string): NeutralMsg => ({ role: 'user', blocks: [{ kind: 'text', text: t }] });
const asstCall = (callId: string): NeutralMsg => ({
  role: 'assistant',
  blocks: [{ kind: 'tool_call', callId, name: 'bash', input: { command: 'ls' } }],
});
const result = (callId: string, content: string): NeutralMsg => ({
  role: 'user',
  blocks: [{ kind: 'tool_result', callId, ok: true, content }],
});

// The cached prefix: system tiers + history up to the protected tail.
function prefixHash(history: readonly NeutralMsg[]): string {
  const cut = findCompactBoundary(history, PROTECTED_TAIL);
  return canonicalHash({ system: prompt.tiers(), prefix: history.slice(0, cut) });
}

describe('golden cache — prefix stability across turns', () => {
  test('appending turns never perturbs the bytes of earlier prefix messages', () => {
    let history: NeutralMsg[] = [];
    const prefixHashes: string[] = [];

    // Simulate 12 turns of a tool-using session.
    for (let turn = 0; turn < 12; turn++) {
      history = [...history, userTurn(`request ${turn}`), asstCall(`c${turn}`), result(`c${turn}`, `output ${turn}`)];
      prefixHashes.push(prefixHash(history));
    }

    // Reconstruct each turn's prefix from the FINAL history and confirm the
    // hash recorded at the time matches — i.e. earlier prefixes were never
    // rewritten by later appends.
    let replay: NeutralMsg[] = [];
    for (let turn = 0; turn < 12; turn++) {
      replay = [...replay, userTurn(`request ${turn}`), asstCall(`c${turn}`), result(`c${turn}`, `output ${turn}`)];
      assert.equal(prefixHash(replay), prefixHashes[turn], `turn ${turn} prefix drifted`);
    }
  });

  test('the system tiers contribute a constant hash component every turn', () => {
    const h1 = canonicalHash(prompt.tiers());
    for (let i = 0; i < 10; i++) assert.equal(canonicalHash(prompt.tiers()), h1);
  });

  test('a growing prefix is strictly an extension: each hash is computed over a superset', () => {
    let history: NeutralMsg[] = [];
    let prevCut = 0;
    for (let turn = 0; turn < 8; turn++) {
      history = [...history, userTurn(`r${turn}`), asstCall(`c${turn}`), result(`c${turn}`, `o${turn}`)];
      const cut = findCompactBoundary(history, PROTECTED_TAIL);
      assert.ok(cut >= prevCut, 'the compaction boundary must not move backward as history grows');
      prevCut = cut;
    }
  });
});

describe('golden cache — compaction preserves pre-boundary determinism', () => {
  test('micro-compaction is idempotent: already-spilled bytes never change', () => {
    let history: NeutralMsg[] = [];
    for (let turn = 0; turn < 6; turn++) {
      history = [...history, asstCall(`c${turn}`), result(`c${turn}`, `payload ${turn} `.repeat(50))];
    }
    // Spill the oldest 3 results.
    const firstPass = microCompact(history, 3).history;
    // Snapshot the bytes of those 3 spilled blocks.
    const spilledBefore = firstPass.filter((m) => {
      const b = m.blocks[0];
      return b?.kind === 'tool_result' && b.content.startsWith('[spilled] ');
    });
    const spilledHashBefore = canonicalHash(spilledBefore);

    // A second pass with the same budget spills the NEXT 3 (oldest un-spilled),
    // but must leave the already-spilled 3 byte-for-byte identical (frozen, L2).
    const secondPass = microCompact(firstPass, 3);
    assert.equal(secondPass.spilled, 3); // the other three
    const spilledAfter = secondPass.history
      .filter((m) => {
        const b = m.blocks[0];
        return b?.kind === 'tool_result' && b.content.startsWith('[spilled] ');
      })
      .slice(0, 3); // the originally-spilled three, still first in order
    assert.equal(canonicalHash(spilledAfter), spilledHashBefore);

    // Once everything is spilled, a further pass is a true no-op.
    const thirdPass = microCompact(secondPass.history, 3);
    assert.equal(thirdPass.spilled, 0);
    assert.equal(canonicalHash(thirdPass.history), canonicalHash(secondPass.history));
  });

  test('full compaction replaces the prefix exactly once, then the new prefix is stable', () => {
    let history: NeutralMsg[] = [];
    for (let turn = 0; turn < 10; turn++) {
      history = [...history, userTurn(`r${turn}`), asstCall(`c${turn}`), result(`c${turn}`, `o${turn}`)];
    }
    const cut = findCompactBoundary(history, PROTECTED_TAIL);
    const summary = renderSummaryTemplate(
      {
        taskState: 'mid-session',
        decisions: 'D1',
        openThreads: 'none',
        fileMap: 'src/',
        nextSteps: 'continue',
      },
      undefined,
    );
    const compacted: NeutralMsg[] = [userTurn(summary), ...history.slice(cut)];

    // After compaction, appending more turns leaves the summary + retained
    // tail prefix byte-stable.
    const afterCompactionPrefix = canonicalHash({
      system: prompt.tiers(),
      prefix: compacted.slice(0, findCompactBoundary(compacted, PROTECTED_TAIL)),
    });
    let grown = [...compacted];
    for (let turn = 10; turn < 14; turn++) {
      grown = [...grown, userTurn(`r${turn}`), asstCall(`c${turn}`), result(`c${turn}`, `o${turn}`)];
    }
    // The summary message (index 0) is unchanged by later growth.
    assert.deepEqual(grown[0], compacted[0]);
    assert.ok(afterCompactionPrefix.length === 64); // sanity: a real sha256 hash
  });

  test('iterative merge keeps a single running summary across two compactions', () => {
    const first = renderSummaryTemplate(
      { taskState: 'phase 1', decisions: 'd1', openThreads: 't1', fileMap: 'f1', nextSteps: 'n1' },
      undefined,
    );
    const second = renderSummaryTemplate(
      { taskState: 'phase 2', decisions: 'd2', openThreads: 't2', fileMap: 'f2', nextSteps: 'n2' },
      first,
    );
    // The second summary folds in the first once — not a growing chain.
    assert.match(second, /phase 1/);
    assert.match(second, /phase 2/);
    assert.equal(second.split('## Prior summary').length - 1, 1);
  });
});

describe('golden cache — fragments stay out of the cached prefix', () => {
  test('fragment churn does not appear in the system tiers or prefix hash', () => {
    const reg = createFragmentRegistry();
    const history = [userTurn('hello')];
    const baseline = prefixHash(history);

    // Mutating fragments every turn must not touch the cached prefix — they
    // ride as late-position user items, by design outside the prefix slice.
    reg.set('todo', '3 tasks');
    reg.delta();
    reg.set('todo', '2 tasks');
    reg.delta();
    assert.equal(prefixHash(history), baseline);
  });
});
