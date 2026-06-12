import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeTodoTool } from '../../../../src/tools/builtin/todo.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

const ctx = () => mkCtx('/');

describe('todo builtin', () => {
  test('declares itself: write-class state, but concurrency-safe in-memory', () => {
    const todo = makeTodoTool();
    assert.equal(todo.name, 'todo');
    assert.equal(todo.permissionKey({ todos: [] }).action, 'read');
  });

  test('replace-list semantics: write returns confirmation, uiData carries the list', async () => {
    const todo = makeTodoTool();
    const todos = [
      { content: 'first', status: 'in_progress' },
      { content: 'second', status: 'pending' },
    ] as const;
    const out = await todo.run({ todos: [...todos] }, ctx());
    assert.ok(out.content.includes('2'), `confirmation should count items, got: ${out.content}`);
    assert.deepEqual(out.uiData, { todos: [...todos] });
  });

  test('next write replaces the previous list entirely', async () => {
    const todo = makeTodoTool();
    await todo.run({ todos: [{ content: 'old', status: 'pending' }] }, ctx());
    const out = await todo.run({ todos: [{ content: 'new', status: 'completed' }] }, ctx());
    assert.deepEqual(out.uiData, { todos: [{ content: 'new', status: 'completed' }] });
    assert.deepEqual(todo.current(), [{ content: 'new', status: 'completed' }]);
  });

  test('empty list is a valid clear', async () => {
    const todo = makeTodoTool();
    await todo.run({ todos: [{ content: 'x', status: 'pending' }] }, ctx());
    const out = await todo.run({ todos: [] }, ctx());
    assert.deepEqual(todo.current(), []);
    assert.ok(out.content.length > 0);
  });

  test('invalid status → ModelFacingError listing allowed values', async () => {
    const todo = makeTodoTool();
    await assert.rejects(
      todo.run({ todos: [{ content: 'x', status: 'bogus' as never }] }, ctx()),
      (err: unknown) => err instanceof ModelFacingError && /pending|in_progress|completed/.test(err.message),
    );
  });

  test('empty content → ModelFacingError', async () => {
    const todo = makeTodoTool();
    await assert.rejects(
      todo.run({ todos: [{ content: '', status: 'pending' }] }, ctx()),
      (err: unknown) => err instanceof ModelFacingError,
    );
  });

  test('factory isolation: two instances do not share state', async () => {
    const a = makeTodoTool();
    const b = makeTodoTool();
    await a.run({ todos: [{ content: 'mine', status: 'pending' }] }, ctx());
    assert.deepEqual(b.current(), []);
  });
});
