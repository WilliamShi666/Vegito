import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMemoryFiles, MEMORY_FILE_CAP } from '../../../src/context/discovery.ts';

let root = '';
let home = '';
let project = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vegito-disc-'));
  home = join(root, 'home');
  project = join(root, 'home', 'work', 'proj');
  mkdirSync(join(home, '.vegito'), { recursive: true });
  mkdirSync(project, { recursive: true });
});
after(() => rmSync(root, { recursive: true, force: true }));

describe('discoverMemoryFiles', () => {
  test('finds a VEGITO.md in the project directory', () => {
    writeFileSync(join(project, 'VEGITO.md'), 'project rules');
    const found = discoverMemoryFiles({ cwd: project, home });
    assert.ok(found.some((f) => f.content === 'project rules'));
  });

  test('recognises VEGITO.md, CLAUDE.md, and AGENTS.md', () => {
    writeFileSync(join(project, 'CLAUDE.md'), 'claude file');
    writeFileSync(join(project, 'AGENTS.md'), 'agents file');
    const found = discoverMemoryFiles({ cwd: project, home });
    const contents = found.map((f) => f.content);
    assert.ok(contents.includes('claude file'));
    assert.ok(contents.includes('agents file'));
  });

  test('project files come before home files (project wins precedence)', () => {
    writeFileSync(join(project, 'VEGITO.md'), 'project');
    writeFileSync(join(home, '.vegito', 'MEMORY.md'), 'home memory');
    const found = discoverMemoryFiles({ cwd: project, home });
    const projIdx = found.findIndex((f) => f.content === 'project');
    const homeIdx = found.findIndex((f) => f.content === 'home memory');
    assert.ok(projIdx !== -1 && homeIdx !== -1);
    assert.ok(projIdx < homeIdx, 'project files should precede home files');
  });

  test('walks up from cwd toward home, collecting ancestor memory files', () => {
    // A VEGITO.md at an intermediate ancestor is discovered.
    writeFileSync(join(home, 'work', 'VEGITO.md'), 'ancestor rules');
    const found = discoverMemoryFiles({ cwd: project, home });
    assert.ok(found.some((f) => f.content === 'ancestor rules'));
  });

  test('missing files are simply absent — no throw', () => {
    const empty = join(root, 'nowhere');
    mkdirSync(empty, { recursive: true });
    assert.doesNotThrow(() => discoverMemoryFiles({ cwd: empty, home }));
  });

  test('content is capped at MEMORY_FILE_CAP bytes', () => {
    const big = 'x'.repeat(MEMORY_FILE_CAP + 5000);
    writeFileSync(join(project, 'VEGITO.md'), big);
    const found = discoverMemoryFiles({ cwd: project, home });
    const f = found.find((x) => x.content.startsWith('x'));
    assert.ok(f !== undefined);
    assert.ok(f.content.length <= MEMORY_FILE_CAP, `content ${f.content.length} exceeds cap`);
  });

  test('the returned path is recorded for each file', () => {
    writeFileSync(join(project, 'VEGITO.md'), 'r');
    const found = discoverMemoryFiles({ cwd: project, home });
    const f = found.find((x) => x.content === 'r');
    assert.ok(f?.path.endsWith('VEGITO.md'));
  });

  test('discovery is deterministic — same inputs, same order (cache stability)', () => {
    writeFileSync(join(project, 'VEGITO.md'), 'a');
    writeFileSync(join(project, 'CLAUDE.md'), 'b');
    const first = discoverMemoryFiles({ cwd: project, home });
    const second = discoverMemoryFiles({ cwd: project, home });
    assert.deepEqual(first, second);
  });
});
