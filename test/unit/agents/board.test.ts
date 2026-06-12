// P9 board (DESIGN §9): the coordination surface for detached children.
// claim() is an atomic check-and-set — exactly one claimer wins a task, even
// under a stampede. Owners heartbeat to keep a claim alive; a claim whose
// heartbeat goes stale can be reclaimed so a dead worker never wedges a task.
// complete() enforces done-after-writes: the result is stored in the same
// step that flips status to 'done', so any reader that sees 'done' is
// guaranteed to see the result.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createBoard } from '../../../src/agents/board.ts';

test('add then claim transitions open → claimed with an owner', () => {
  const board = createBoard();
  board.add('t1');
  assert.equal(board.get('t1')?.status, 'open');
  assert.equal(board.claim('t1', 'worker-a'), true);
  assert.equal(board.get('t1')?.status, 'claimed');
  assert.equal(board.get('t1')?.owner, 'worker-a');
});

test('claim is atomic: a second claimer on a claimed task loses', () => {
  const board = createBoard();
  board.add('t1');
  assert.equal(board.claim('t1', 'a'), true);
  assert.equal(board.claim('t1', 'b'), false);
  assert.equal(board.get('t1')?.owner, 'a');
});

test('claim on an unknown task returns false', () => {
  const board = createBoard();
  assert.equal(board.claim('ghost', 'a'), false);
});

test('race: 1000 iterations, N concurrent claimers, exactly one wins each time', async () => {
  for (let iter = 0; iter < 1000; iter++) {
    const board = createBoard();
    board.add('task');
    // Fire many claimers "concurrently"; claim() is synchronous so the
    // check-and-set cannot interleave — exactly one must win.
    const claimers = Array.from({ length: 8 }, (_, i) => () => board.claim('task', `w${i}`));
    const results = await Promise.all(claimers.map((c) => Promise.resolve().then(c)));
    const winners = results.filter((r) => r === true);
    assert.equal(winners.length, 1, `iteration ${iter}: ${winners.length} winners`);
  }
});

test('heartbeat refreshes the claim; complete stores the result (done-after-writes)', () => {
  let clock = 1000;
  const board = createBoard({ now: () => clock });
  board.add('t1');
  board.claim('t1', 'a');
  clock = 2000;
  board.heartbeat('t1', 'a');
  assert.equal(board.get('t1')?.lastHeartbeat, 2000);
  board.complete('t1', 'a', 'RESULT-PAYLOAD');
  const task = board.get('t1');
  assert.equal(task?.status, 'done');
  assert.equal(task?.result, 'RESULT-PAYLOAD'); // result present the instant status is done
});

test('complete by a non-owner is rejected', () => {
  const board = createBoard();
  board.add('t1');
  board.claim('t1', 'a');
  assert.throws(() => board.complete('t1', 'b', 'x'), /owner/i);
  assert.equal(board.get('t1')?.status, 'claimed');
});

test('a stale claim can be reclaimed; a fresh one cannot', () => {
  let clock = 0;
  const board = createBoard({ now: () => clock, staleMs: 100 });
  board.add('t1');
  board.claim('t1', 'a');
  clock = 50; // within stale window
  assert.equal(board.claim('t1', 'b'), false);
  clock = 200; // past stale window, owner 'a' never heartbeat
  assert.equal(board.claim('t1', 'b'), true);
  assert.equal(board.get('t1')?.owner, 'b');
});

test('list reports tasks; openTasks filters to claimable', () => {
  const board = createBoard();
  board.add('a');
  board.add('b');
  board.claim('a', 'w');
  assert.equal(board.list().length, 2);
  assert.deepEqual(board.openTasks().map((t) => t.id), ['b']);
});
