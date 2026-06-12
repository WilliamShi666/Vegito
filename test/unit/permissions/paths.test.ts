import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWithin } from '../../../src/permissions/paths.ts';

// Fixture layout (all under a fresh tmp root):
//   root/
//     ws/                  <- workspace
//       sub/
//         file.txt
//       ..hidden           <- child whose name starts with ".."
//       link-out -> root/outside/
//       link-in  -> ws/sub/
//     ws2/                 <- sibling sharing "ws" as a string prefix
//     outside/
//       secret.txt
let root = '';
let ws = '';

before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vegito-paths-')));
  ws = join(root, 'ws');
  mkdirSync(join(ws, 'sub'), { recursive: true });
  mkdirSync(join(root, 'ws2'));
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(ws, 'sub', 'file.txt'), 'x');
  writeFileSync(join(ws, '..hidden'), 'x');
  writeFileSync(join(root, 'outside', 'secret.txt'), 'x');
  symlinkSync(join(root, 'outside'), join(ws, 'link-out'));
  symlinkSync(join(ws, 'sub'), join(ws, 'link-in'));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveWithin — plain containment', () => {
  test('relative path inside the workspace', () => {
    const r = resolveWithin(ws, 'sub/file.txt');
    assert.equal(r.inside, true);
    assert.equal(r.real, join(ws, 'sub', 'file.txt'));
  });

  test('absolute path inside the workspace', () => {
    const r = resolveWithin(ws, join(ws, 'sub', 'file.txt'));
    assert.equal(r.inside, true);
  });

  test('absolute path outside the workspace', () => {
    const r = resolveWithin(ws, '/etc/passwd');
    assert.equal(r.inside, false);
  });

  test('the workspace itself is inside', () => {
    const r = resolveWithin(ws, '.');
    assert.equal(r.inside, true);
    assert.equal(r.real, ws);
  });

  test('.. that escapes the workspace is outside', () => {
    const r = resolveWithin(ws, '../ws2/x');
    assert.equal(r.inside, false);
  });

  test('.. that stays inside the workspace is inside', () => {
    const r = resolveWithin(ws, 'sub/../sub/file.txt');
    assert.equal(r.inside, true);
    assert.equal(r.real, join(ws, 'sub', 'file.txt'));
  });

  test('sibling directory sharing a string prefix is OUTSIDE (no startsWith bug)', () => {
    const r = resolveWithin(ws, join(root, 'ws2', 'x'));
    assert.equal(r.inside, false);
  });

  test('a child literally named "..hidden" is inside', () => {
    const r = resolveWithin(ws, '..hidden');
    assert.equal(r.inside, true);
    assert.equal(r.real, join(ws, '..hidden'));
  });
});

describe('resolveWithin — nonexistent paths', () => {
  test('nonexistent path under the workspace resolves textually and is inside', () => {
    const r = resolveWithin(ws, 'brand/new/dir/out.txt');
    assert.equal(r.inside, true);
    assert.equal(r.real, join(ws, 'brand', 'new', 'dir', 'out.txt'));
  });

  test('nonexistent path that climbs out via .. is outside', () => {
    const r = resolveWithin(ws, 'nope/../../escape.txt');
    assert.equal(r.inside, false);
    assert.equal(r.real, join(root, 'escape.txt'));
  });
});

describe('resolveWithin — symlinks', () => {
  test('symlink pointing outside the workspace is outside', () => {
    const r = resolveWithin(ws, 'link-out/secret.txt');
    assert.equal(r.inside, false);
    assert.equal(r.real, join(root, 'outside', 'secret.txt'));
  });

  test('symlink pointing inside the workspace is inside', () => {
    const r = resolveWithin(ws, 'link-in/file.txt');
    assert.equal(r.inside, true);
    assert.equal(r.real, join(ws, 'sub', 'file.txt'));
  });

  test('ADVERSARIAL: .. after an outside symlink must follow the symlink target, not the text', () => {
    // POSIX: link-out/.. = (root/outside)/.. = root — OUTSIDE the workspace.
    // A tokenizer that collapses ".." textually before resolving symlinks
    // would see ws/x and wrongly report inside.
    const r = resolveWithin(ws, 'link-out/../x');
    assert.equal(r.inside, false);
    assert.equal(r.real, join(root, 'x'));
  });

  test('.. after an inside symlink lands at the TARGET parent, not the link parent', () => {
    // link-in -> ws/sub, so link-in/.. = ws — inside, and real reflects ws.
    const r = resolveWithin(ws, 'link-in/../..hidden');
    assert.equal(r.inside, true);
    assert.equal(r.real, join(ws, '..hidden'));
  });
});
