import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DEFAULTS } from '../../../src/config/schema.ts';
import { mergeConfig, loadConfig } from '../../../src/config/load.ts';

describe('mergeConfig', () => {
  test('no layers → defaults, deep-frozen', () => {
    const { config, warnings } = mergeConfig([]);
    assert.deepEqual(config, CONFIG_DEFAULTS);
    assert.ok(Object.isFrozen(config));
    assert.deepEqual(warnings, []);
  });

  test('later layers win (defaults < home < project)', () => {
    const { config, warnings } = mergeConfig([
      { source: '~/.vegito/config.json', values: { model: 'claude-haiku-4-5-20251001', maxIterations: 25 } },
      { source: './.vegito/config.json', values: { model: 'claude-fable-5' } },
    ]);
    assert.equal(config.model, 'claude-fable-5'); // project overrode home
    assert.equal(config.maxIterations, 25); // home survived where project was silent
    assert.equal(config.permissionMode, CONFIG_DEFAULTS.permissionMode);
    assert.deepEqual(warnings, []);
  });

  test('unknown keys warn with key + source, and are dropped', () => {
    const { config, warnings } = mergeConfig([
      { source: './.vegito/config.json', values: { modle: 'typo-1', trace: true } },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /modle/);
    assert.match(warnings[0] ?? '', /\.vegito\/config\.json/);
    assert.equal(config.trace, true);
    assert.ok(!('modle' in config));
  });

  test('wrong-typed values warn and keep the prior value', () => {
    const { config, warnings } = mergeConfig([
      { source: 'home', values: { maxIterations: 'ten' } },
    ]);
    assert.equal(config.maxIterations, CONFIG_DEFAULTS.maxIterations);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /maxIterations/);
  });

  test('permissionMode is constrained to its enum', () => {
    const { config, warnings } = mergeConfig([
      { source: 'home', values: { permissionMode: 'yolo' } },
    ]);
    assert.equal(config.permissionMode, CONFIG_DEFAULTS.permissionMode);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /permissionMode/);
  });
});

describe('loadConfig (file layers)', () => {
  test('reads home then project config; missing files are fine; bad JSON warns', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vegito-config-'));
    const home = join(root, 'home');
    const cwd = join(root, 'proj');
    await mkdir(join(home, '.vegito'), { recursive: true });
    await mkdir(join(cwd, '.vegito'), { recursive: true });
    await writeFile(join(home, '.vegito', 'config.json'), JSON.stringify({ model: 'claude-haiku-4-5-20251001', trace: true }));
    await writeFile(join(cwd, '.vegito', 'config.json'), JSON.stringify({ model: 'claude-fable-5' }));

    const { config, warnings } = await loadConfig({ homeDir: home, cwd });
    assert.equal(config.model, 'claude-fable-5');
    assert.equal(config.trace, true);
    assert.deepEqual(warnings, []);

    // missing files: still boots to merged defaults
    const empty = await loadConfig({ homeDir: join(root, 'nohome'), cwd: join(root, 'nocwd') });
    assert.deepEqual(empty.config, CONFIG_DEFAULTS);
    assert.deepEqual(empty.warnings, []);

    // malformed JSON: warn, skip layer, never throw
    await writeFile(join(cwd, '.vegito', 'config.json'), '{ not json');
    const bad = await loadConfig({ homeDir: home, cwd });
    assert.equal(bad.config.model, 'claude-haiku-4-5-20251001'); // home layer still applied
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0] ?? '', /config\.json/);
  });
});
