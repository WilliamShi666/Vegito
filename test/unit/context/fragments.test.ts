import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { createFragmentRegistry } from '../../../src/context/fragments.ts';

describe('createFragmentRegistry — diffing', () => {
  test('first delta emits every registered fragment', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'two open tasks');
    reg.set('files', 'main.ts seen');
    const changed = reg.delta();
    assert.deepEqual(
      changed.map((f) => f.id).sort(),
      ['files', 'todo'],
    );
  });

  test('a second delta with no changes emits nothing', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'two open tasks');
    reg.delta();
    assert.deepEqual(reg.delta(), []);
  });

  test('only fragments whose content changed are re-emitted', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'two open tasks');
    reg.set('files', 'main.ts seen');
    reg.delta();
    reg.set('todo', 'one open task'); // changed
    // files unchanged
    const changed = reg.delta();
    assert.deepEqual(changed.map((f) => f.id), ['todo']);
    assert.equal(changed[0]?.content, 'one open task');
  });

  test('setting a fragment to its current value is not a change', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'same');
    reg.delta();
    reg.set('todo', 'same');
    assert.deepEqual(reg.delta(), []);
  });

  test('a newly added fragment after the first delta is emitted', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'x');
    reg.delta();
    reg.set('board', 'agent-1 idle');
    assert.deepEqual(reg.delta().map((f) => f.id), ['board']);
  });

  test('removing a fragment emits a tombstone with empty content once', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'x');
    reg.delta();
    reg.remove('todo');
    const changed = reg.delta();
    assert.deepEqual(changed.map((f) => f.id), ['todo']);
    assert.equal(changed[0]?.content, '');
    assert.equal(changed[0]?.removed, true);
    assert.deepEqual(reg.delta(), []); // tombstone emitted once
  });

  test('removing an unknown fragment is a no-op', () => {
    const reg = createFragmentRegistry();
    reg.remove('ghost');
    assert.deepEqual(reg.delta(), []);
  });
});

describe('createFragmentRegistry — ordering and snapshot', () => {
  test('delta preserves first-registration order', () => {
    const reg = createFragmentRegistry();
    reg.set('c', '1');
    reg.set('a', '1');
    reg.set('b', '1');
    assert.deepEqual(reg.delta().map((f) => f.id), ['c', 'a', 'b']);
  });

  test('snapshot() lists all live fragments regardless of change state', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'x');
    reg.set('files', 'y');
    reg.delta(); // clears change set
    assert.deepEqual(
      reg.snapshot().map((f) => ({ id: f.id, content: f.content })),
      [
        { id: 'todo', content: 'x' },
        { id: 'files', content: 'y' },
      ],
    );
  });

  test('snapshot excludes removed fragments', () => {
    const reg = createFragmentRegistry();
    reg.set('todo', 'x');
    reg.remove('todo');
    assert.deepEqual(reg.snapshot(), []);
  });
});
