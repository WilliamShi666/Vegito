import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveProfile, type ModelProfile } from '../../../src/providers/profile.ts';
import { BUILTIN_CATALOG, mergeCatalog, loadCatalog } from '../../../src/providers/catalog.ts';

const MINI: ModelProfile = {
  id: 'mini-1',
  wire: 'openai',
  contextWindow: 8000,
  maxOutput: 1000,
  reasoning: false,
  aliases: ['mini'],
};

describe('resolveProfile', () => {
  test('finds by exact id, then by alias; unknown returns undefined', () => {
    const catalog = [MINI];
    assert.equal(resolveProfile(catalog, 'mini-1'), MINI);
    assert.equal(resolveProfile(catalog, 'mini'), MINI);
    assert.equal(resolveProfile(catalog, 'nope'), undefined);
  });

  test('exact id wins over another profile alias', () => {
    const shadow: ModelProfile = { ...MINI, id: 'real', aliases: ['mini-1'] };
    const catalog = [shadow, MINI];
    assert.equal(resolveProfile(catalog, 'mini-1'), MINI);
  });
});

describe('BUILTIN_CATALOG', () => {
  test('ships claude-fable-5 on the anthropic wire with reasoning support', () => {
    const fable = resolveProfile(BUILTIN_CATALOG, 'claude-fable-5');
    assert.ok(fable);
    assert.equal(fable.wire, 'anthropic');
    assert.equal(fable.reasoning, true);
    assert.ok(fable.contextWindow >= 200000);
  });

  test('every entry has a positive context window and output cap', () => {
    for (const p of BUILTIN_CATALOG) {
      assert.ok(p.contextWindow > 0, p.id);
      assert.ok(p.maxOutput > 0, p.id);
    }
  });
});

describe('mergeCatalog', () => {
  test('user entries override builtins by id and new ids append', () => {
    const { catalog, warnings } = mergeCatalog(
      [MINI],
      [
        { id: 'mini-1', wire: 'openai', contextWindow: 16000, maxOutput: 2000, reasoning: true },
        { id: 'fresh', wire: 'anthropic', contextWindow: 100, maxOutput: 10, reasoning: false },
      ],
    );
    assert.deepEqual(warnings, []);
    assert.equal(catalog.length, 2);
    assert.equal(resolveProfile(catalog, 'mini-1')?.contextWindow, 16000);
    assert.equal(resolveProfile(catalog, 'fresh')?.wire, 'anthropic');
  });

  test('invalid entries warn and are skipped, valid ones still land', () => {
    const { catalog, warnings } = mergeCatalog(
      [MINI],
      [
        { id: 'broken', contextWindow: 1 }, // missing wire/maxOutput/reasoning
        'not-an-object',
        { id: 'good', wire: 'openai', contextWindow: 10, maxOutput: 5, reasoning: false },
      ],
    );
    assert.equal(warnings.length, 2);
    assert.ok(warnings[0]?.includes('broken'));
    assert.equal(catalog.length, 2);
    assert.ok(resolveProfile(catalog, 'good'));
  });
});

describe('loadCatalog', () => {
  test('missing file returns the builtin catalog with no warnings', async () => {
    const { catalog, warnings } = await loadCatalog({ file: '/nonexistent/models.json' });
    assert.deepEqual(warnings, []);
    assert.equal(catalog.length, BUILTIN_CATALOG.length);
  });

  test('a valid file merges over the builtins; bad JSON warns and keeps builtins', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vegito-catalog-'));
    try {
      const good = join(dir, 'models.json');
      await writeFile(
        good,
        JSON.stringify([{ id: 'local-llm', wire: 'openai', contextWindow: 32000, maxOutput: 4000, reasoning: false }]),
      );
      const ok = await loadCatalog({ file: good });
      assert.deepEqual(ok.warnings, []);
      assert.ok(resolveProfile(ok.catalog, 'local-llm'));

      const bad = join(dir, 'bad.json');
      await writeFile(bad, '{nope');
      const fallback = await loadCatalog({ file: bad });
      assert.equal(fallback.warnings.length, 1);
      assert.equal(fallback.catalog.length, BUILTIN_CATALOG.length);

      const notArray = join(dir, 'obj.json');
      await writeFile(notArray, '{"id":"x"}');
      const objWarn = await loadCatalog({ file: notArray });
      assert.equal(objWarn.warnings.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
