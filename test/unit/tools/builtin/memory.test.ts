import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeMemoryTool } from '../../../../src/tools/builtin/memory.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-mem-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = () => mkCtx('/');

describe('memory builtin', () => {
  test('declares itself: save is write-class, list/read are read-class and parallel-safe', () => {
    const mem = makeMemoryTool(dir);
    assert.equal(mem.name, 'memory');
    assert.equal(mem.permissionKey({ action: 'save', name: 'x', content: 'y' }).action, 'write');
    assert.equal(mem.permissionKey({ action: 'list' }).action, 'read');
    assert.equal(mem.permissionKey({ action: 'read', name: 'x' }).action, 'read');
    assert.equal(mem.concurrencySafe({ action: 'save', name: 'x', content: 'y' }), false);
    assert.equal(mem.concurrencySafe({ action: 'list' }), true);
  });

  test('save → read roundtrip; file lands inside the memory dir', async () => {
    const mem = makeMemoryTool(join(dir, 'a'));
    await mem.run({ action: 'save', name: 'user-prefs', content: 'likes terse output' }, ctx());
    const out = await mem.run({ action: 'read', name: 'user-prefs' }, ctx());
    assert.ok(out.content.includes('likes terse output'));
    assert.equal(await readFile(join(dir, 'a', 'user-prefs.md'), 'utf8'), 'likes terse output');
  });

  test('list shows saved names; empty store has an explicit marker', async () => {
    const mem = makeMemoryTool(join(dir, 'b'));
    const empty = await mem.run({ action: 'list' }, ctx());
    assert.ok(/no memories/i.test(empty.content), `got: ${empty.content}`);
    await mem.run({ action: 'save', name: 'alpha', content: '1' }, ctx());
    await mem.run({ action: 'save', name: 'beta', content: '2' }, ctx());
    const out = await mem.run({ action: 'list' }, ctx());
    assert.deepEqual(out.content.split('\n').sort(), ['alpha', 'beta']);
  });

  test('save overwrites an existing memory (update semantics)', async () => {
    const mem = makeMemoryTool(join(dir, 'c'));
    await mem.run({ action: 'save', name: 'k', content: 'old' }, ctx());
    await mem.run({ action: 'save', name: 'k', content: 'new' }, ctx());
    const out = await mem.run({ action: 'read', name: 'k' }, ctx());
    assert.ok(out.content.includes('new'));
    assert.ok(!out.content.includes('old'));
  });

  test('reading a missing memory → ModelFacingError naming it', async () => {
    const mem = makeMemoryTool(join(dir, 'd'));
    await assert.rejects(
      mem.run({ action: 'read', name: 'ghost' }, ctx()),
      (err: unknown) => err instanceof ModelFacingError && err.message.includes('ghost'),
    );
  });

  test('hostile names cannot escape the memory dir', async () => {
    const mem = makeMemoryTool(join(dir, 'e'));
    await mem.run({ action: 'save', name: '../../escape', content: 'contained' }, ctx());
    const listed = await mem.run({ action: 'list' }, ctx());
    assert.equal(listed.content.split('\n').length, 1, 'exactly one memory saved');
    const file = await readFile(join(dir, 'e', `${listed.content.trim()}.md`), 'utf8');
    assert.equal(file, 'contained');
  });

  test('missing required fields → ModelFacingError', async () => {
    const mem = makeMemoryTool(join(dir, 'f'));
    await assert.rejects(mem.run({ action: 'save', name: 'x' }, ctx()), (e: unknown) => e instanceof ModelFacingError);
    await assert.rejects(mem.run({ action: 'save', content: 'x' }, ctx()), (e: unknown) => e instanceof ModelFacingError);
    await assert.rejects(mem.run({ action: 'read' }, ctx()), (e: unknown) => e instanceof ModelFacingError);
  });
});
