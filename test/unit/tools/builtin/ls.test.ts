import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lsTool } from '../../../../src/tools/builtin/ls.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-ls-'));
  await mkdir(join(dir, 'sub'));
  await mkdir(join(dir, 'a-dir'));
  await writeFile(join(dir, 'b.txt'), 'b');
  await writeFile(join(dir, 'a.txt'), 'a');
  await writeFile(join(dir, '.hidden'), 'h');
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ls builtin', () => {
  test('declares itself: read-class, parallel-safe, targeted permission key', () => {
    assert.equal(lsTool.name, 'ls');
    assert.equal(lsTool.concurrencySafe({}), true);
    assert.deepEqual(lsTool.permissionKey({ path: '/x' }), { tool: 'ls', action: 'read', target: '/x' });
  });

  test('sorted listing; directories marked with a trailing slash; dotfiles shown', async () => {
    const out = await lsTool.run({ path: dir }, mkCtx('/'));
    assert.deepEqual(out.content.split('\n'), ['.hidden', 'a-dir/', 'a.txt', 'b.txt', 'sub/']);
  });

  test('path defaults to ctx.cwd', async () => {
    const out = await lsTool.run({}, mkCtx(dir));
    assert.ok(out.content.includes('a.txt'));
  });

  test('missing path → ModelFacingError naming it', async () => {
    await assert.rejects(
      lsTool.run({ path: join(dir, 'ghost') }, mkCtx(dir)),
      (err: unknown) => err instanceof ModelFacingError && err.message.includes('ghost'),
    );
  });

  test('a file → ModelFacingError steering to read', async () => {
    await assert.rejects(
      lsTool.run({ path: join(dir, 'a.txt') }, mkCtx(dir)),
      (err: unknown) => err instanceof ModelFacingError && /not a directory|use read/i.test(err.message),
    );
  });

  test('empty directory → explicit marker', async () => {
    const empty = join(dir, 'sub'); // created with nothing inside
    const out = await lsTool.run({ path: empty }, mkCtx(dir));
    assert.ok(out.content.includes('empty'), `got: ${out.content}`);
  });

  test('huge directory is capped with a note', async () => {
    const big = join(dir, 'big');
    await mkdir(big);
    await Promise.all(Array.from({ length: 1050 }, (_, i) => writeFile(join(big, `f${String(i).padStart(4, '0')}`), '')));
    const out = await lsTool.run({ path: big }, mkCtx(dir));
    const lines = out.content.split('\n');
    assert.ok(lines.length <= 1001, `got ${lines.length} lines`); // 1000 entries + note
    assert.ok(/more entries|truncated/i.test(out.content));
  });
});
