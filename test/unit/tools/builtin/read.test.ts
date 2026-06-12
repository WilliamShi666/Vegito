import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool } from '../../../../src/tools/builtin/read.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-read-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('read builtin', () => {
  test('declares itself: read-class, parallel-safe, targeted permission key', () => {
    assert.equal(readTool.name, 'read');
    assert.equal(readTool.concurrencySafe({ file_path: '/x' }), true);
    assert.deepEqual(readTool.permissionKey({ file_path: '/x' }), {
      tool: 'read',
      action: 'read',
      target: '/x',
    });
  });

  test('numbered cat -n style output', async () => {
    const f = join(dir, 'three.txt');
    await writeFile(f, 'alpha\nbeta\ngamma\n');
    const out = await readTool.run({ file_path: f }, mkCtx(dir));
    assert.equal(out.content, '     1\talpha\n     2\tbeta\n     3\tgamma');
  });

  test('offset/limit window (offset is 1-based)', async () => {
    const f = join(dir, 'five.txt');
    await writeFile(f, 'l1\nl2\nl3\nl4\nl5\n');
    const out = await readTool.run({ file_path: f, offset: 2, limit: 2 }, mkCtx(dir));
    assert.equal(out.content, '     2\tl2\n     3\tl3');
  });

  test('relative paths resolve against ctx.cwd', async () => {
    await writeFile(join(dir, 'rel.txt'), 'here\n');
    const out = await readTool.run({ file_path: 'rel.txt' }, mkCtx(dir));
    assert.equal(out.content, '     1\there');
  });

  test('notes the file as seen in the FileState ledger', async () => {
    const f = join(dir, 'seen.txt');
    await writeFile(f, 'x\n');
    const ctx = mkCtx(dir);
    await readTool.run({ file_path: f }, ctx);
    assert.ok(ctx.files.seenAt(f) !== undefined, 'read must record the mtime it saw');
  });

  test('missing file → ModelFacingError naming the path', async () => {
    const f = join(dir, 'nope.txt');
    await assert.rejects(
      readTool.run({ file_path: f }, mkCtx(dir)),
      (err: unknown) => err instanceof ModelFacingError && err.message.includes('nope.txt'),
    );
  });

  test('directory → ModelFacingError steering to ls', async () => {
    const d = join(dir, 'subdir');
    await mkdir(d, { recursive: true });
    await assert.rejects(
      readTool.run({ file_path: d }, mkCtx(dir)),
      (err: unknown) => err instanceof ModelFacingError && /directory/i.test(err.message),
    );
  });

  test('empty file → explicit marker, not silence', async () => {
    const f = join(dir, 'empty.txt');
    await writeFile(f, '');
    const out = await readTool.run({ file_path: f }, mkCtx(dir));
    assert.ok(out.content.includes('empty'), `got: ${out.content}`);
  });

  test('image extensions → stub placeholder (no binary dump)', async () => {
    const f = join(dir, 'pic.png');
    await writeFile(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const out = await readTool.run({ file_path: f }, mkCtx(dir));
    assert.ok(out.content.startsWith('[image'), `got: ${out.content}`);
    assert.match(out.content, /pic\.png/);
    assert.ok(!out.content.includes('\uFFFD'), 'binary bytes must not leak');
  });

  test('line cap: a file beyond the default window reports truncation', async () => {
    const f = join(dir, 'big.txt');
    const lines = Array.from({ length: 2100 }, (_, i) => `line-${i + 1}`);
    await writeFile(f, lines.join('\n'));
    const out = await readTool.run({ file_path: f }, mkCtx(dir));
    assert.ok(out.content.includes('     1\tline-1'));
    assert.ok(out.content.includes('line-2000'));
    assert.ok(!out.content.includes('line-2001\n'), 'window is 2000 lines');
    assert.ok(/truncated|more lines/i.test(out.content), 'must say there is more');
  });

  test('over-long lines are hard-capped per line', async () => {
    const f = join(dir, 'wide.txt');
    await writeFile(f, `${'w'.repeat(3000)}\nshort`);
    const out = await readTool.run({ file_path: f }, mkCtx(dir));
    const firstLine = out.content.split('\n')[0] as string;
    assert.ok(firstLine.length <= 2000 + 7, `line not capped: ${firstLine.length}`);
    assert.ok(out.content.includes('short'));
  });
});
