import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  CredentialPool,
  credentialFromEnv,
  baseUrlFromEnv,
  DEFAULT_COOL_MS,
  type Credential,
} from '../../../src/providers/credentials.ts';

const A: Credential = { id: 'a', headers: { 'x-api-key': 'ka' } };
const B: Credential = { id: 'b', headers: { 'x-api-key': 'kb' } };

describe('CredentialPool', () => {
  test('current() returns the first valid credential; empty pool returns undefined', () => {
    assert.equal(new CredentialPool([]).current(), undefined);
    const pool = new CredentialPool([A, B]);
    assert.equal(pool.current()?.id, 'a');
    assert.equal(pool.current()?.id, 'a'); // idempotent read
    assert.equal(pool.size, 2);
  });

  test('401 kills a credential permanently and rotation moves to the next', () => {
    const pool = new CredentialPool([A, B]);
    pool.reportFailure('a', 401);
    assert.equal(pool.current()?.id, 'b');
    pool.reportFailure('b', 403);
    assert.equal(pool.current(), undefined);
    assert.deepEqual(
      pool.statuses().map((s) => s.state),
      ['dead', 'dead'],
    );
  });

  test('429 cools a credential for retryAfterMs, then it recovers', () => {
    let now = 1000;
    const pool = new CredentialPool([A, B], { now: () => now });
    pool.reportFailure('a', 429, 5000);
    assert.equal(pool.current()?.id, 'b');
    assert.equal(pool.statuses()[0]?.state, 'cooling');
    now = 6001; // past coolUntil = 1000 + 5000
    pool.reportFailure('b', 401); // b dies, a should be usable again
    assert.equal(pool.current()?.id, 'a');
  });

  test('429 without retryAfter uses the default cool window', () => {
    let now = 0;
    const pool = new CredentialPool([A], { now: () => now });
    pool.reportFailure('a', 429);
    assert.equal(pool.current(), undefined);
    assert.equal(pool.statuses()[0]?.coolUntil, DEFAULT_COOL_MS);
    now = DEFAULT_COOL_MS;
    assert.equal(pool.current()?.id, 'a');
  });

  test('5xx is not a credential fault and changes nothing', () => {
    const pool = new CredentialPool([A]);
    pool.reportFailure('a', 500);
    assert.equal(pool.current()?.id, 'a');
    assert.equal(pool.statuses()[0]?.state, 'valid');
  });

  test('reportSuccess restores a cooling credential immediately', () => {
    let now = 0;
    const pool = new CredentialPool([A], { now: () => now });
    pool.reportFailure('a', 429, 60000);
    assert.equal(pool.current(), undefined);
    pool.reportSuccess('a');
    assert.equal(pool.current()?.id, 'a');
  });

  test('unknown ids are ignored', () => {
    const pool = new CredentialPool([A]);
    pool.reportFailure('nope', 401);
    assert.equal(pool.current()?.id, 'a');
  });
});

describe('credentialFromEnv', () => {
  test('anthropic kind maps to x-api-key; openai kind to a bearer header', () => {
    process.env['VEGITO_TEST_KEY'] = 'sk-test';
    try {
      const anth = credentialFromEnv('anth', 'VEGITO_TEST_KEY', 'anthropic');
      assert.deepEqual(anth, { id: 'anth', headers: { 'x-api-key': 'sk-test' } });
      const oai = credentialFromEnv('oai', 'VEGITO_TEST_KEY', 'openai');
      assert.deepEqual(oai, { id: 'oai', headers: { authorization: 'Bearer sk-test' } });
    } finally {
      delete process.env['VEGITO_TEST_KEY'];
    }
  });

  test('missing or empty env var returns null', () => {
    delete process.env['VEGITO_TEST_MISSING'];
    assert.equal(credentialFromEnv('x', 'VEGITO_TEST_MISSING', 'anthropic'), null);
    process.env['VEGITO_TEST_MISSING'] = '';
    try {
      assert.equal(credentialFromEnv('x', 'VEGITO_TEST_MISSING', 'anthropic'), null);
    } finally {
      delete process.env['VEGITO_TEST_MISSING'];
    }
  });
});

describe('baseUrlFromEnv', () => {
  const KINDS = [
    { kind: 'anthropic', envVar: 'ANTHROPIC_BASE_URL' },
    { kind: 'openai', envVar: 'OPENAI_BASE_URL' },
  ] as const;

  test('reads the conventional override per kind and trims a trailing slash', () => {
    for (const { kind, envVar } of KINDS) {
      const saved = process.env[envVar];
      process.env[envVar] = 'https://gw.example.com/api/';
      try {
        assert.equal(baseUrlFromEnv(kind), 'https://gw.example.com/api');
      } finally {
        if (saved === undefined) delete process.env[envVar];
        else process.env[envVar] = saved;
      }
    }
  });

  test('unset or empty means no override', () => {
    for (const { kind, envVar } of KINDS) {
      const saved = process.env[envVar];
      delete process.env[envVar];
      try {
        assert.equal(baseUrlFromEnv(kind), undefined);
        process.env[envVar] = '';
        assert.equal(baseUrlFromEnv(kind), undefined);
      } finally {
        if (saved === undefined) delete process.env[envVar];
        else process.env[envVar] = saved;
      }
    }
  });
});
