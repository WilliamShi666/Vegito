import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTool } from '../../../../src/tools/builtin/write.ts';
import { readTool } from '../../../../src/tools/builtin/read.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-write-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('write builtin', () => {
  test('declares itself: write-class, serial, targeted permission key', () => {
    assert.equal(writeTool.name, 'write');
    assert.equal(writeTool.concurrencySafe({ file_path: '/x', content: '' }), false);
    assert.deepEqual(writeTool.permissionKey({ file_path: '/x', content: '' }), {
      tool: 'write',
      action: 'write',
      target: '/x',
    });
  });

  test('creates a new file, parent dirs included; content round-trips byte-exact', async () => {
    const f = join(dir, 'deep', 'nested', 'new.txt');
    const ctx = mkCtx(dir);
    const out = await writeTool.run({ file_path: f, content: 'hello\nworld\n' }, ctx);
    assert.equal(await readFile(f, 'utf8'), 'hello\nworld\n');
    assert.ok(out.content.includes(f), 'confirmation names the path');
    assert.ok(ctx.files.seenAt(f) !== undefined, 'write notes its own mtime');
  });

  test('overwriting a file never read this session is refused', async () => {
    const f = join(dir, 'precious.txt');
    await writeFile(f, 'original');
    await assert.rejects(
      writeTool.run({ file_path: f, content: 'clobber' }, mkCtx(dir)),
      (err: unknown) => err instanceof ModelFacingError && /read/i.test(err.message),
    );
    assert.equal(await readFile(f, 'utf8'), 'original', 'file must be untouched');
  });

  test('overwrite after read succeeds', async () => {
    const f = join(dir, 'known.txt');
    await writeFile(f, 'v1');
    const ctx = mkCtx(dir);
    await readTool.run({ file_path: f }, ctx);
    await writeTool.run({ file_path: f, content: 'v2' }, ctx);
    assert.equal(await readFile(f, 'utf8'), 'v2');
  });

  test('externally modified since read → stale refusal', async () => {
    const f = join(dir, 'racy.txt');
    await writeFile(f, 'v1');
    const ctx = mkCtx(dir);
    await readTool.run({ file_path: f }, ctx);
    const future = new Date(Date.now() + 60_000);
    await utimes(f, future, future); // someone else touched it after our read
    await assert.rejects(
      writeTool.run({ file_path: f, content: 'v2' }, ctx),
      (err: unknown) => err instanceof ModelFacingError && /modified|changed|stale/i.test(err.message),
    );
    assert.equal(await readFile(f, 'utf8'), 'v1');
  });

  test('relative paths resolve against ctx.cwd', async () => {
    const ctx = mkCtx(dir);
    await writeTool.run({ file_path: 'relative-new.txt', content: 'rel' }, ctx);
    assert.equal(await readFile(join(dir, 'relative-new.txt'), 'utf8'), 'rel');
  });
});
