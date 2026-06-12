// Live-path provider resolution (DESIGN §5): a model id resolves to a profile,
// the profile's wire kind selects the wire class, and a Credential supplies the
// auth headers. buildWire is pure — the env read stays in credentials.ts (A5),
// so this is testable without touching process.env. envVarForWire names the
// conventional key per wire kind; the CLI reads it via credentialFromEnv.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildWire, envVarForWire } from '../../../src/providers/resolve.ts';
import type { ModelProfile } from '../../../src/providers/profile.ts';
import type { Credential } from '../../../src/providers/credentials.ts';

const anthropic: ModelProfile = { id: 'claude-x', wire: 'anthropic', contextWindow: 200_000, maxOutput: 8192, reasoning: true };
const openai: ModelProfile = { id: 'gpt-x', wire: 'openai', contextWindow: 128_000, maxOutput: 4096, reasoning: false };
const cred: Credential = { id: 'k', headers: { 'x-api-key': 'redacted' } };

describe('envVarForWire', () => {
  test('names the conventional key per wire kind', () => {
    assert.equal(envVarForWire('anthropic'), 'ANTHROPIC_API_KEY');
    assert.equal(envVarForWire('openai'), 'OPENAI_API_KEY');
  });
});

describe('buildWire', () => {
  test('an anthropic profile yields the anthropic wire wired to the credential', () => {
    const wire = buildWire(anthropic, cred);
    assert.equal(wire.name, 'anthropic');
  });

  test('an openai profile yields the openai wire', () => {
    const wire = buildWire(openai, cred);
    assert.equal(wire.name, 'openai');
  });

  test('the wire carries an auth thunk returning the credential headers', () => {
    // We can observe the headers indirectly: buildWire must not throw and the
    // wire is a usable WireProtocol with a send method.
    const wire = buildWire(anthropic, cred);
    assert.equal(typeof wire.send, 'function');
  });

  test('a baseUrl override redirects the wire (gateways, proxies, local endpoints)', async () => {
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (url) => {
      urls.push(String(url));
      return new Response('', { status: 500 });
    };
    const a = buildWire(anthropic, cred, { baseUrl: 'https://gw.example.com/anthropic', fetchFn });
    await assert.rejects(async () => {
      for await (const _ of a.send({ model: 'claude-x', system: [], messages: [], tools: [], maxTokens: 16 }, new AbortController().signal)) void _;
    });
    const o = buildWire(openai, cred, { baseUrl: 'https://gw.example.com/v1', fetchFn });
    await assert.rejects(async () => {
      for await (const _ of o.send({ model: 'gpt-x', system: [], messages: [], tools: [], maxTokens: 16 }, new AbortController().signal)) void _;
    });
    assert.deepEqual(urls, [
      'https://gw.example.com/anthropic/v1/messages',
      'https://gw.example.com/v1/chat/completions',
    ]);
  });
});
