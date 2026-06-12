import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepTool } from '../../../../src/tools/builtin/grep.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-grep-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'const needle = 1;\nplain line\nNEEDLE again\n');
  await writeFile(join(dir, 'src', 'b.js'), 'needle in js\n');
  await writeFile(join(dir, 'node_modules', 'x.ts'), 'needle hidden\n');
  await writeFile(join(dir, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('grep builtin', () => {
  test('declares itself: read-class, parallel-safe', () => {
    assert.equal(grepTool.name, 'grep');
    assert.equal(grepTool.concurrencySafe({ pattern: 'x' }), true);
    assert.equal(grepTool.permissionKey({ pattern: 'x' }).action, 'read');
  });

  test('matches as path:line:text across files, sorted by path', async () => {
    const out = await grepTool.run({ pattern: 'needle' }, mkCtx(dir));
    assert.deepEqual(out.content.split('\n'), [
      `${join(dir, 'src', 'a.ts')}:1:const needle = 1;`,
      `${join(dir, 'src', 'b.js')}:1:needle in js`,
    ]);
  });

  test('ignore_case widens the match', async () => {
    const out = await grepTool.run({ pattern: 'needle', ignore_case: true }, mkCtx(dir));
    assert.ok(out.content.includes(':3:NEEDLE again'));
  });

  test('glob filter narrows candidates', async () => {
    const out = await grepTool.run({ pattern: 'needle', glob: '**/*.js' }, mkCtx(dir));
    assert.equal(out.content, `${join(dir, 'src', 'b.js')}:1:needle in js`);
  });

  test('node_modules is skipped; binary files are sniffed out', async () => {
    const out = await grepTool.run({ pattern: 'needle' }, mkCtx(dir));
    assert.ok(!out.content.includes('node_modules'));
    assert.ok(!out.content.includes('bin.dat'));
  });

  test('invalid regex → ModelFacingError naming the pattern problem', async () => {
    await assert.rejects(
      grepTool.run({ pattern: '(' }, mkCtx(dir)),
      (err: unknown) => err instanceof ModelFacingError && /regex|pattern/i.test(err.message),
    );
  });

  test('no matches → explicit marker, not an error', async () => {
    const out = await grepTool.run({ pattern: 'zebra-quark' }, mkCtx(dir));
    assert.ok(out.content.includes('no matches'), `got: ${out.content}`);
  });

  test('match flood is capped with a note', async () => {
    const flood = join(dir, 'flood.txt');
    await writeFile(flood, Array.from({ length: 600 }, (_, i) => `hit ${i}`).join('\n'));
    const out = await grepTool.run({ pattern: 'hit', glob: 'flood.txt' }, mkCtx(dir));
    const lines = out.content.split('\n');
    assert.ok(lines.length <= 501, `got ${lines.length} lines`);
    assert.match(out.content, /truncated|more match/i);
  });
});
