// Layered config load (DESIGN §11): defaults < ~/.vegito < ./.vegito < CLI
// flags, merged by pure mergeConfig, frozen at boot. Loading never throws on
// bad user input — it warns and keeps booting (a harness that refuses to
// start over a typo is worse than one that tells you about it).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validate } from '../lib/jsonschema.ts';
import { CONFIG_DEFAULTS, CONFIG_KEY_SCHEMAS, type VegitoConfig } from './schema.ts';

export interface ConfigLayer {
  source: string;
  values: Record<string, unknown>;
}

export interface LoadedConfig {
  config: VegitoConfig;
  warnings: string[];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isProviderChains(value: unknown): value is Readonly<Record<string, readonly string[]>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(isStringArray);
}

function isCompaction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return (
    (obj['maxTokens'] === undefined || (typeof obj['maxTokens'] === 'number' && Number.isInteger(obj['maxTokens']))) &&
    (obj['protectedTail'] === undefined || (typeof obj['protectedTail'] === 'number' && Number.isInteger(obj['protectedTail'])))
  );
}

function isEvolve(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return obj['defaultApply'] === undefined || typeof obj['defaultApply'] === 'boolean';
}

function customConfigError(key: keyof VegitoConfig, value: unknown): string | undefined {
  if (key === 'providerChains' && !isProviderChains(value)) return 'expected an object of string arrays';
  if (key === 'compaction' && !isCompaction(value)) return 'expected an object with integer maxTokens/protectedTail';
  if (key === 'evolve' && !isEvolve(value)) return 'expected an object with boolean defaultApply';
  return undefined;
}

function mergeValue(config: VegitoConfig, key: keyof VegitoConfig, value: unknown): VegitoConfig {
  if (key === 'providerChains') {
    return { ...config, providerChains: { ...config.providerChains, ...(value as Readonly<Record<string, readonly string[]>>) } };
  }
  if (key === 'compaction') {
    return { ...config, compaction: { ...config.compaction, ...(value as Partial<VegitoConfig['compaction']>) } };
  }
  if (key === 'evolve') {
    return { ...config, evolve: { ...config.evolve, ...(value as Partial<VegitoConfig['evolve']>) } };
  }
  return { ...config, [key]: value };
}

export function mergeConfig(layers: readonly ConfigLayer[]): LoadedConfig {
  const warnings: string[] = [];
  let config: VegitoConfig = CONFIG_DEFAULTS;
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.values)) {
      if (!(key in CONFIG_KEY_SCHEMAS)) {
        warnings.push(`unknown config key "${key}" in ${layer.source} (ignored)`);
        continue;
      }
      const configKey = key as keyof VegitoConfig;
      const customError = customConfigError(configKey, value);
      if (customError !== undefined) {
        warnings.push(`invalid value for "${key}" in ${layer.source}: ${customError} (ignored)`);
        continue;
      }
      const schema = CONFIG_KEY_SCHEMAS[configKey];
      const result = validate(schema, value);
      if (!result.ok) {
        warnings.push(`invalid value for "${key}" in ${layer.source}: ${result.errors[0]?.message} (ignored)`);
        continue;
      }
      config = mergeValue(config, configKey, value);
    }
  }
  return { config: Object.freeze(config), warnings };
}

async function readLayer(file: string): Promise<{ layer: ConfigLayer | null; warning: string | null }> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { layer: null, warning: null }; // absent file is the normal case
  }
  try {
    const values = JSON.parse(text) as Record<string, unknown>;
    return { layer: { source: file, values }, warning: null };
  } catch {
    return { layer: null, warning: `could not parse ${file} as JSON (layer skipped)` };
  }
}

export async function loadConfig(opts: {
  homeDir: string;
  cwd: string;
  cliLayer?: ConfigLayer;
}): Promise<LoadedConfig> {
  const warnings: string[] = [];
  const layers: ConfigLayer[] = [];
  for (const file of [join(opts.homeDir, '.vegito', 'config.json'), join(opts.cwd, '.vegito', 'config.json')]) {
    const { layer, warning } = await readLayer(file);
    if (warning) warnings.push(warning);
    if (layer) layers.push(layer);
  }
  if (opts.cliLayer) layers.push(opts.cliLayer);
  const merged = mergeConfig(layers);
  return { config: merged.config, warnings: [...warnings, ...merged.warnings] };
}
