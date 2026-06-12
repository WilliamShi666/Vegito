import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { ToolRegistry } from '../../../src/tools/registry.ts';
import { defineTool, type ToolSpec } from '../../../src/tools/spec.ts';

function mk(name: string, opts?: { exposure?: ToolSpec['exposure']; description?: string }): ToolSpec {
  return defineTool({
    name,
    description: opts?.description ?? `${name} tool`,
    schema: { type: 'object' },
    ...(opts?.exposure === undefined ? {} : { exposure: opts.exposure }),
    run: async () => ({ content: name }),
  });
}

describe('ToolRegistry', () => {
  test('register + lookup by name; unknown returns undefined', () => {
    const reg = new ToolRegistry();
    const read = mk('read');
    reg.register(read);
    assert.equal(reg.get('read'), read);
    assert.equal(reg.get('nope'), undefined);
  });

  test('duplicate names throw — namespace collisions are programmer errors', () => {
    const reg = new ToolRegistry();
    reg.register(mk('x'));
    assert.throws(() => reg.register(mk('x')), /already registered/);
  });

  test('list() returns direct + deferred but never hidden; listAll() returns everything', () => {
    const reg = new ToolRegistry();
    reg.register(mk('a'));
    reg.register(mk('b', { exposure: 'deferred' }));
    reg.register(mk('c', { exposure: 'hidden' }));
    assert.deepEqual(
      reg.list().map((t) => t.name),
      ['a', 'b'],
    );
    assert.deepEqual(
      reg.listAll().map((t) => t.name),
      ['a', 'b', 'c'],
    );
  });

  test('listHash is stable across registration order and changes with content', () => {
    const r1 = new ToolRegistry();
    r1.register(mk('a'));
    r1.register(mk('b'));
    const r2 = new ToolRegistry();
    r2.register(mk('b'));
    r2.register(mk('a'));
    assert.equal(r1.listHash(), r2.listHash()); // order-independent (D4 cache identity)

    const r3 = new ToolRegistry();
    r3.register(mk('a'));
    r3.register(mk('b', { description: 'different words' }));
    assert.notEqual(r1.listHash(), r3.listHash());

    const r4 = new ToolRegistry();
    r4.register(mk('a'));
    r4.register(mk('b', { exposure: 'hidden' }));
    assert.notEqual(r1.listHash(), r4.listHash()); // hidden tools change the exposed surface
  });
});
