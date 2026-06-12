// Live-path provider resolution (DESIGN §5): a model profile's wire kind picks
// the wire class, and a Credential supplies the auth headers. buildWire is pure
// — the environment read stays in credentials.ts (A5) — so the CLI composes
// `resolveProfile → credentialFromEnv → buildWire` while this stays testable
// without touching the environment.

import type { ModelProfile, WireKind } from './profile.ts';
import type { Credential } from './credentials.ts';
import type { WireProtocol } from './types.ts';
import { AnthropicWire } from './wire/anthropic.ts';
import { OpenAiWire } from './wire/openai.ts';

const ENV_VARS: Record<WireKind, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

export function envVarForWire(kind: WireKind): string {
  return ENV_VARS[kind];
}

export interface BuildWireOpts {
  /** Endpoint override (gateways, proxies, local endpoints); default = the wire's own host. */
  readonly baseUrl?: string;
  /** Injected fetch for tests; default globalThis.fetch. */
  readonly fetchFn?: typeof fetch;
}

export function buildWire(profile: ModelProfile, credential: Credential, opts: BuildWireOpts = {}): WireProtocol {
  const wireOpts = {
    auth: (): Record<string, string> => credential.headers,
    ...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
    ...(opts.fetchFn === undefined ? {} : { fetchFn: opts.fetchFn }),
  };
  return profile.wire === 'anthropic' ? new AnthropicWire(wireOpts) : new OpenAiWire(wireOpts);
}
