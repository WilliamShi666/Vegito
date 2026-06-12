import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globTool } from '../../../../src/tools/builtin/glob.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-glob-'));
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(join(dir, '.git'), { recursive: true });
  await writeFile(join(dir, 'top.ts'), '');
  await writeFile(join(dir, 'src', 'a.ts'), '');
  await writeFile(join(dir, 'src', 'b.js'), '');
  await writeFile(join(dir, 'src', 'deep', 'c.ts'), '');
  await writeFile(join(dir, 'node_modules', 'pkg', 'x.ts'), '');
  await writeFile(join(dir, '.git', 'y.ts'), '');
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('glob builtin', () => {
  test('declares itself: read-class, parallel-safe', () => {
    assert.equal(globTool.name, 'glob');
    assert.equal(globTool.concurrencySafe({ pattern: '*' }), true);
    assert.equal(globTool.permissionKey({ pattern: '*' }).action, 'read');
  });

  test('recursive pattern returns absolute paths, sorted', async () => {
    const out = await globTool.run({ pattern: '**/*.ts' }, mkCtx(dir));
    assert.deepEqual(out.content.split('\n'), [
      join(dir, 'src', 'a.ts'),
      join(dir, 'src', 'deep', 'c.ts'),
      join(dir, 'top.ts'),
    ]);
  });

  test('node_modules and .git are excluded by default', async () => {
    const out = await globTool.run({ pattern: '**/*.ts' }, mkCtx(dir));
    assert.ok(!out.content.includes('node_modules'));
    assert.ok(!out.content.includes('.git'));
  });

  test('path param overrides the search root', async () => {
    const out = await globTool.run({ pattern: '*.ts', path: join(dir, 'src') }, mkCtx('/elsewhere'));
    assert.equal(out.content, join(dir, 'src', 'a.ts'));
  });

  test('no matches → explicit empty marker, not an error', async () => {
    const out = await globTool.run({ pattern: '**/*.rs' }, mkCtx(dir));
    assert.ok(out.content.includes('no matches'), `got: ${out.content}`);
  });
});
