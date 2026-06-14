import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  test('ships claude-sonnet-4-6 on the anthropic wire with reasoning support', () => {
    const sonnet = resolveProfile(BUILTIN_CATALOG, 'claude-sonnet-4-6');
    assert.ok(sonnet);
    assert.equal(sonnet.wire, 'anthropic');
    assert.equal(sonnet.reasoning, true);
    assert.ok(sonnet.contextWindow >= 200000);
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
        {
          id: 'fresh',
          wire: 'anthropic',
          contextWindow: 100,
          maxOutput: 10,
          reasoning: false,
          baseUrl: 'https://gateway.example/anthropic',
        },
      ],
    );
    assert.deepEqual(warnings, []);
    assert.equal(catalog.length, 2);
    assert.equal(resolveProfile(catalog, 'mini-1')?.contextWindow, 16000);
    assert.equal(resolveProfile(catalog, 'fresh')?.wire, 'anthropic');
    assert.equal(resolveProfile(catalog, 'fresh')?.baseUrl, 'https://gateway.example/anthropic');
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

  test('loads object-shaped catalog files with model metadata and aliases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vegito-catalog-object-'));
    try {
      const file = join(dir, 'models.json');
      await writeFile(
        file,
        JSON.stringify({
          schema: 1,
          models: {
            'deepseek-v4-pro': {
              wire: 'anthropic',
              contextWindow: 128000,
              maxOutput: 64000,
              reasoning: true,
              baseUrl: 'https://api.deepseek.com/anthropic',
              aliases: ['deepseek-pro'],
            },
          },
        }),
      );

      const result = await loadCatalog({ files: [file] });
      assert.deepEqual(result.warnings, []);
      assert.equal(resolveProfile(result.catalog, 'deepseek-pro')?.id, 'deepseek-v4-pro');
      assert.equal(resolveProfile(result.catalog, 'deepseek-v4-pro')?.wire, 'anthropic');
      assert.equal(resolveProfile(result.catalog, 'deepseek-v4-pro')?.baseUrl, 'https://api.deepseek.com/anthropic');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('loads multiple catalog overlays in order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vegito-catalog-many-'));
    try {
      const first = join(dir, 'first.json');
      const second = join(dir, 'second.json');
      await writeFile(first, JSON.stringify([{ id: 'local', wire: 'openai', contextWindow: 1, maxOutput: 1, reasoning: false }]));
      await writeFile(second, JSON.stringify([{ id: 'local', wire: 'anthropic', contextWindow: 2, maxOutput: 2, reasoning: true }]));

      const result = await loadCatalog({ files: [first, second] });
      assert.equal(result.warnings.length, 0);
      assert.equal(resolveProfile(result.catalog, 'local')?.wire, 'anthropic');
      assert.equal(resolveProfile(result.catalog, 'local')?.contextWindow, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('repository seed catalog contains DeepSeek Anthropic-compatible profiles', async () => {
    const seed = resolve('catalog/models.json');
    const result = await loadCatalog({ files: [seed] });
    assert.deepEqual(result.warnings, []);
    const pro = resolveProfile(result.catalog, 'deepseek-v4-pro');
    const flash = resolveProfile(result.catalog, 'deepseek-v4-flash');
    assert.equal(pro?.wire, 'anthropic');
    assert.equal(pro?.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(pro?.contextWindow, 1_000_000);
    assert.equal(pro?.maxOutput, 384_000);
    assert.equal(flash?.wire, 'anthropic');
    assert.equal(flash?.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(flash?.contextWindow, 1_000_000);
    assert.equal(flash?.maxOutput, 384_000);
  });
});
