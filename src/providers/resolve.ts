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

export function buildWire(profile: ModelProfile, credential: Credential): WireProtocol {
  const auth = (): Record<string, string> => credential.headers;
  return profile.wire === 'anthropic' ? new AnthropicWire({ auth }) : new OpenAiWire({ auth });
}
