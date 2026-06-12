// P9 messaging (DESIGN §9): inter-agent messages with two delivery modes.
// QueueOnly leaves a message for the recipient to pick up on its next natural
// turn (drain). TriggerTurn does the same but also wakes the recipient now via
// a registered waker. The mailbox is the whole contract; who wakes and how a
// turn starts is the caller's concern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMailbox, type AgentMessage } from '../../../src/agents/messaging.ts';

function msg(to: string, body: string, mode: AgentMessage['mode']): AgentMessage {
  return { from: 'orchestrator', to, body, mode };
}

test('QueueOnly message is drained on the next turn, no wake', () => {
  const box = createMailbox();
  let woke = 0;
  box.registerWaker('worker', () => (woke += 1));
  box.send(msg('worker', 'status?', 'QueueOnly'));
  assert.equal(woke, 0);
  const drained = box.drain('worker');
  assert.deepEqual(drained.map((m) => m.body), ['status?']);
  assert.deepEqual(box.drain('worker'), []); // drain clears
});

test('TriggerTurn message wakes the recipient and is still drainable', () => {
  const box = createMailbox();
  let woke = 0;
  box.registerWaker('worker', () => (woke += 1));
  box.send(msg('worker', 'stop now', 'TriggerTurn'));
  assert.equal(woke, 1);
  assert.deepEqual(box.drain('worker').map((m) => m.body), ['stop now']);
});

test('TriggerTurn with no registered waker still queues the message', () => {
  const box = createMailbox();
  box.send(msg('ghost', 'hi', 'TriggerTurn'));
  assert.deepEqual(box.drain('ghost').map((m) => m.body), ['hi']);
});

test('messages preserve FIFO order per recipient', () => {
  const box = createMailbox();
  box.send(msg('w', 'first', 'QueueOnly'));
  box.send(msg('w', 'second', 'QueueOnly'));
  box.send(msg('w', 'third', 'QueueOnly'));
  assert.deepEqual(box.drain('w').map((m) => m.body), ['first', 'second', 'third']);
});

test('mailboxes are isolated per recipient', () => {
  const box = createMailbox();
  box.send(msg('a', 'for-a', 'QueueOnly'));
  box.send(msg('b', 'for-b', 'QueueOnly'));
  assert.deepEqual(box.drain('a').map((m) => m.body), ['for-a']);
  assert.deepEqual(box.drain('b').map((m) => m.body), ['for-b']);
});

test('pending reports whether a recipient has queued messages', () => {
  const box = createMailbox();
  assert.equal(box.pending('w'), false);
  box.send(msg('w', 'x', 'QueueOnly'));
  assert.equal(box.pending('w'), true);
  box.drain('w');
  assert.equal(box.pending('w'), false);
});
