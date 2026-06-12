import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool } from '../../../../src/tools/builtin/edit.ts';
import { readTool } from '../../../../src/tools/builtin/read.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';
import type { ToolCtx } from '../../../../src/tools/spec.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-edit-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freshFile(name: string, content: string): Promise<{ f: string; ctx: ToolCtx }> {
  const f = join(dir, name);
  await writeFile(f, content);
  const ctx = mkCtx(dir);
  await readTool.run({ file_path: f }, ctx);
  return { f, ctx };
}

describe('edit builtin', () => {
  test('declares itself: write-class, serial, targeted permission key', () => {
    const input = { file_path: '/x', old_string: 'a', new_string: 'b' };
    assert.equal(editTool.name, 'edit');
    assert.equal(editTool.concurrencySafe(input), false);
    assert.deepEqual(editTool.permissionKey(input), { tool: 'edit', action: 'write', target: '/x' });
  });

  test('replaces a unique match exactly once', async () => {
    const { f, ctx } = await freshFile('one.txt', 'alpha beta gamma\n');
    const out = await editTool.run({ file_path: f, old_string: 'beta', new_string: 'BETA' }, ctx);
    assert.equal(await readFile(f, 'utf8'), 'alpha BETA gamma\n');
    assert.ok(out.content.includes(f));
  });

  test('editing a file never read this session is refused', async () => {
    const f = join(dir, 'unread.txt');
    await writeFile(f, 'x y z');
    await assert.rejects(
      editTool.run({ file_path: f, old_string: 'x', new_string: 'q' }, mkCtx(dir)),
      (err: unknown) => err instanceof ModelFacingError && /read/i.test(err.message),
    );
  });

  test('externally modified since read → stale refusal, file untouched', async () => {
    const { f, ctx } = await freshFile('racy.txt', 'v1 marker');
    const future = new Date(Date.now() + 60_000);
    await utimes(f, future, future);
    await assert.rejects(
      editTool.run({ file_path: f, old_string: 'marker', new_string: 'M' }, ctx),
      (err: unknown) => err instanceof ModelFacingError && /modified|changed|stale/i.test(err.message),
    );
    assert.equal(await readFile(f, 'utf8'), 'v1 marker');
  });

  test('old_string not found → repairable error naming the problem', async () => {
    const { f, ctx } = await freshFile('miss.txt', 'nothing here\n');
    await assert.rejects(
      editTool.run({ file_path: f, old_string: 'ghost', new_string: 'g' }, ctx),
      (err: unknown) => err instanceof ModelFacingError && /not found/i.test(err.message),
    );
  });

  test('ambiguous match without replace_all → refused with the count', async () => {
    const { f, ctx } = await freshFile('multi.txt', 'dup X dup X dup\n');
    await assert.rejects(
      editTool.run({ file_path: f, old_string: 'dup', new_string: 'D' }, ctx),
      (err: unknown) => err instanceof ModelFacingError && err.message.includes('3'),
    );
    assert.equal(await readFile(f, 'utf8'), 'dup X dup X dup\n', 'no partial application');
  });

  test('replace_all replaces every occurrence and reports the count', async () => {
    const { f, ctx } = await freshFile('all.txt', 'dup X dup X dup\n');
    const out = await editTool.run({ file_path: f, old_string: 'dup', new_string: 'D', replace_all: true }, ctx);
    assert.equal(await readFile(f, 'utf8'), 'D X D X D\n');
    assert.ok(out.content.includes('3'));
  });

  test('old_string === new_string → refused', async () => {
    const { f, ctx } = await freshFile('same.txt', 'abc\n');
    await assert.rejects(
      editTool.run({ file_path: f, old_string: 'abc', new_string: 'abc' }, ctx),
      (err: unknown) => err instanceof ModelFacingError,
    );
  });

  test('empty old_string → refused', async () => {
    const { f, ctx } = await freshFile('empty-old.txt', 'abc\n');
    await assert.rejects(
      editTool.run({ file_path: f, old_string: '', new_string: 'x' }, ctx),
      (err: unknown) => err instanceof ModelFacingError,
    );
  });

  test('a second edit chains without re-reading (we noted our own write)', async () => {
    const { f, ctx } = await freshFile('chain.txt', 'one two\n');
    await editTool.run({ file_path: f, old_string: 'one', new_string: '1' }, ctx);
    await editTool.run({ file_path: f, old_string: 'two', new_string: '2' }, ctx);
    assert.equal(await readFile(f, 'utf8'), '1 2\n');
  });
});
