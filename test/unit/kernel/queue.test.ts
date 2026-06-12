import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { CommandQueue, type QueuedCommand } from '../../../src/kernel/queue.ts';

const cmd = (id: string, kind: QueuedCommand['kind']): QueuedCommand => ({ id, kind });

describe('CommandQueue', () => {
  test('drain(accept) returns everything FIFO and empties the queue', () => {
    const q = new CommandQueue();
    q.push(cmd('1', 'user_msg'));
    q.push(cmd('2', 'interrupt'));
    q.push(cmd('3', 'control'));
    assert.equal(q.size, 3);
    assert.deepEqual(q.drain('accept').map((c) => c.id), ['1', '2', '3']);
    assert.equal(q.size, 0);
    assert.deepEqual(q.drain('accept'), []);
  });

  test('drain(defer_startup) holds back user_msg, releases interrupt + control', () => {
    const q = new CommandQueue();
    q.push(cmd('u1', 'user_msg'));
    q.push(cmd('i1', 'interrupt'));
    q.push(cmd('u2', 'user_msg'));
    q.push(cmd('c1', 'control'));
    assert.deepEqual(q.drain('defer_startup').map((c) => c.id), ['i1', 'c1']);
    // deferred items remain, original order intact
    assert.equal(q.size, 2);
    assert.deepEqual(q.drain('accept').map((c) => c.id), ['u1', 'u2']);
  });

  test('drain(defer_compact) releases only interrupts', () => {
    const q = new CommandQueue();
    q.push(cmd('u1', 'user_msg'));
    q.push(cmd('c1', 'control'));
    q.push(cmd('i1', 'interrupt'));
    assert.deepEqual(q.drain('defer_compact').map((c) => c.id), ['i1']);
    assert.deepEqual(q.drain('accept').map((c) => c.id), ['u1', 'c1']);
  });

  test('deferred items survive repeated restrictive drains unreordered', () => {
    const q = new CommandQueue();
    q.push(cmd('u1', 'user_msg'));
    q.push(cmd('u2', 'user_msg'));
    q.drain('defer_compact');
    q.drain('defer_compact');
    assert.deepEqual(q.drain('accept').map((c) => c.id), ['u1', 'u2']);
  });

  test('payload rides along untouched', () => {
    const q = new CommandQueue();
    q.push({ id: 'x', kind: 'user_msg', payload: { text: '你好' } });
    assert.deepEqual(q.drain('accept')[0]?.payload, { text: '你好' });
  });
});
