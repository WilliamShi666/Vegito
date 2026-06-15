import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { VegitoConfig } from '../../config/schema.ts';
import { loadCatalog } from '../../providers/catalog.ts';
import { baseUrlFromEnv, credentialFromEnv } from '../../providers/credentials.ts';
import { resolveProfile } from '../../providers/profile.ts';
import { buildWire, envVarForWire } from '../../providers/resolve.ts';
import type { NeutralRequest } from '../../providers/types.ts';
import { ScriptedWire, type ScriptedStep } from '../../providers/wire/scripted.ts';
import type { CallModel } from '../runtime.ts';
import type { DispatchPorts } from './dispatch.ts';
import { expandPath } from './runtime-support.ts';
import type { ParsedCommand } from './args.ts';

const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PACKAGE_ROOT = existsSync(join(MODULE_ROOT, 'catalog', 'models.json')) ? MODULE_ROOT : join(MODULE_ROOT, '..');
const TRUSTED_PROFILE_BASE_URLS = new Set(['https://api.deepseek.com/anthropic']);

export interface ModelSeam {
  readonly callModel: CallModel;
  readonly providerName: string;
  readonly modelId: string;
  readonly warnings: readonly string[];
}

export function usage(): string {
  return [
    'usage: vegito <command> [options]',
    '       vegito                         (start interactive REPL)',
    '',
    'commands:',
    '  run -p <prompt> [--json] [--model m] [--mode default|acceptEdits|plan|bypass] [--cwd dir] [--script file]',
    '  repl [--model m] [--mode ...] [--cwd dir] [--pack p] [--script file]',
    '  sessions list|resume <sid>|fork <sid> <recordId>',
    '  packs list|generated|prompt|validate <dir>|validate-output <pack> <candidate-file>|trust <pack>',
    '  forge [--native] [--offline] [--archetype id] [--domain "..."] [--name id] [--from docs] [--out dir]',
    '  evolve <pack> --session <sid> [--mode ...] [--script file] [--apply]  (review a session; apply only with --apply)',
    '  evolve eval <pack>                                                   (evaluate candidates without mutation)',
    '  evolve revert <pack>                                                 (undo the last applied batch)',
    '  version | help',
    '',
  ].join('\n');
}

export function effectiveConfig(base: VegitoConfig, c: ParsedCommand): VegitoConfig {
  if (c.cmd !== 'run' && c.cmd !== 'repl') return base;
  let cfg = base;
  if (c.model !== undefined) cfg = { ...cfg, model: c.model };
  if (c.mode !== undefined) cfg = { ...cfg, permissionMode: c.mode };
  return cfg;
}

export function catalogFilesFor(config: VegitoConfig, cwd: string, homeDir: string): readonly string[] {
  return config.catalogFiles.map((file) =>
    file === 'catalog/models.json' ? join(PACKAGE_ROOT, 'catalog', 'models.json') : expandPath(file, cwd, homeDir),
  );
}

export function writeCatalogWarnings(warnings: readonly string[], ports: DispatchPorts): void {
  for (const warning of warnings) ports.writeErr(`catalog: ${warning}\n`);
}

function credentialEnvVarsForProfile(profile: { readonly id: string; readonly wire: 'anthropic' | 'openai' }): readonly string[] {
  const defaultEnv = envVarForWire(profile.wire);
  if (profile.id.startsWith('deepseek-')) return ['DEEPSEEK_API_KEY', defaultEnv, 'ANTHROPIC_AUTH_TOKEN'];
  return profile.wire === 'anthropic' ? [defaultEnv, 'ANTHROPIC_AUTH_TOKEN'] : [defaultEnv];
}

function trustedProfileBaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value.replace(/\/+$/, ''));
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    const normalized = url.toString().replace(/\/+$/, '');
    return TRUSTED_PROFILE_BASE_URLS.has(normalized) ? normalized : undefined;
  } catch {
    return undefined;
  }
}

// Build the model-call seam. `--script` reads a fixture and plays it through
// ScriptedWire (offline); otherwise resolve a catalog profile + env credential
// and build the live wire. modelId is the canonical id the request body must
// carry; aliases like "haiku" are resolved here, or gateways reject them.
export async function buildCallModel(
  model: string,
  scriptPath: string | undefined,
  catalogFiles: readonly string[] = [],
): Promise<ModelSeam> {
  if (scriptPath !== undefined) {
    const text = await readFile(scriptPath, 'utf8');
    const steps = JSON.parse(text) as readonly ScriptedStep[];
    const wire = new ScriptedWire(steps);
    return { callModel: (req: NeutralRequest, sig: AbortSignal) => wire.send(req, sig), providerName: wire.name, modelId: model, warnings: [] };
  }
  const { catalog, warnings } = await loadCatalog({ files: catalogFiles });
  const profile = resolveProfile(catalog, model);
  if (profile === undefined) throw new Error(`unknown model: ${model} (not in catalog)`);
  const envVars = credentialEnvVarsForProfile(profile);
  const credential = credentialFromEnv(profile.wire, envVars, profile.wire);
  if (credential === null) throw new Error(`missing credential: set ${envVars.join(' or ')} to use ${profile.id}`);
  const baseUrl = baseUrlFromEnv(profile.wire) ?? trustedProfileBaseUrl(profile.baseUrl);
  const wire = buildWire(profile, credential, baseUrl === undefined ? {} : { baseUrl });
  return { callModel: (req: NeutralRequest, sig: AbortSignal) => wire.send(req, sig), providerName: wire.name, modelId: profile.id, warnings };
}
