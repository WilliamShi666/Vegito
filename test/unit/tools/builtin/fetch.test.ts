import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { makeFetchTool, isPrivateAddress } from '../../../../src/tools/builtin/fetch.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

let serverA: Server;
let serverB: Server;
let portA = 0;
let portB = 0;

before(async () => {
  serverB = createServer((req, res) => {
    if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        auth: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
        key: req.headers['x-api-key'] ?? null,
      }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => serverB.listen(0, '127.0.0.1', r));
  portB = (serverB.address() as { port: number }).port;

  serverA = createServer((req, res) => {
    if (req.url === '/hello') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello from A');
    } else if (req.url === '/r-same') {
      res.writeHead(302, { location: '/echo' });
      res.end();
    } else if (req.url === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        auth: req.headers.authorization ?? null,
        cookie: req.headers.cookie ?? null,
        key: req.headers['x-api-key'] ?? null,
      }));
    } else if (req.url === '/r-cross') {
      res.writeHead(302, { location: `http://localhost:${portB}/echo` });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
    } else if (req.url === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('no such page');
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((r) => serverA.listen(0, '127.0.0.1', r));
  portA = (serverA.address() as { port: number }).port;
});

after(async () => {
  serverA.close();
  serverB.close();
});

const ALLOW = { allowHosts: ['127.0.0.1', 'localhost'] };

describe('isPrivateAddress', () => {
  test('private and loopback ranges are private', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.1.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
    }
  });

  test('public addresses are not', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2607:f8b0::1']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
    }
  });

  test('IPv4-mapped IPv6 cannot smuggle a private IPv4', () => {
    assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
    assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  });

  test('0.0.0.0/8, CGNAT, and multicast/reserved v4 are non-public (security review #1)', () => {
    for (const ip of ['0.0.0.0', '0.255.255.255', '100.64.0.1', '100.127.255.255', '224.0.0.1', '240.0.0.1', '255.255.255.255']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`);
    }
    // CGNAT bounds: 100.63.x and 100.128.x are ordinary public space
    assert.equal(isPrivateAddress('100.63.0.1'), false);
    assert.equal(isPrivateAddress('100.128.0.1'), false);
  });

  test('hex/compact/expanded IPv4-mapped IPv6 forms cannot smuggle a private IPv4 (security review #2)', () => {
    for (const ip of [
      '::ffff:7f00:1', // 127.0.0.1
      '::ffff:a00:1', // 10.0.0.1
      '::ffff:c0a8:1', // 192.168.0.1
      '::ffff:ac10:1', // 172.16.0.1
      '::ffff:a9fe:1', // 169.254.0.1
      '0:0:0:0:0:ffff:7f00:1', // expanded hex
      '0:0:0:0:0:ffff:127.0.0.1', // expanded dotted
    ]) {
      assert.equal(isPrivateAddress(ip), true, `${ip} should be blocked`);
    }
    assert.equal(isPrivateAddress('::ffff:808:808'), false, '8.8.8.8 hex-mapped is public');
  });

  test('unparseable input fails closed', () => {
    assert.equal(isPrivateAddress('not-an-ip'), true);
  });
});

describe('fetch builtin', () => {
  test('declares itself: network action targeting the url, parallel-safe', () => {
    const f = makeFetchTool();
    assert.equal(f.name, 'fetch');
    assert.equal(f.concurrencySafe({ url: 'https://x.test' }), true);
    assert.deepEqual(f.permissionKey({ url: 'https://x.test/p' }), {
      tool: 'fetch',
      action: 'network',
      target: 'https://x.test/p',
    });
  });

  test('fetches a page and reports the HTTP status', async () => {
    const f = makeFetchTool(ALLOW);
    const out = await f.run({ url: `http://127.0.0.1:${portA}/hello` }, mkCtx('/'));
    assert.ok(out.content.includes('hello from A'));
    assert.ok(out.content.includes('200'), `status missing: ${out.content.slice(0, 80)}`);
  });

  test('non-2xx is data, not an exception', async () => {
    const f = makeFetchTool(ALLOW);
    const out = await f.run({ url: `http://127.0.0.1:${portA}/missing` }, mkCtx('/'));
    assert.ok(out.content.includes('404'));
    assert.ok(out.content.includes('no such page'));
  });

  test('private/loopback targets are blocked by default (no allowlist)', async () => {
    const f = makeFetchTool();
    await assert.rejects(
      f.run({ url: `http://127.0.0.1:${portA}/hello` }, mkCtx('/')),
      (err: unknown) => err instanceof ModelFacingError && /private|blocked/i.test(err.message),
    );
  });

  test('0.0.0.0 and hex-mapped IPv6 loopback are blocked at the tool level', async () => {
    const f = makeFetchTool();
    for (const url of [`http://0.0.0.0:${portA}/hello`, `http://[::ffff:7f00:1]:${portA}/hello`]) {
      await assert.rejects(
        f.run({ url }, mkCtx('/')),
        (err: unknown) => err instanceof ModelFacingError && /private|blocked/i.test(err.message),
        `${url} should be blocked`,
      );
    }
  });

  test('hostnames resolving to private addresses are blocked (DNS check)', async () => {
    const f = makeFetchTool();
    await assert.rejects(
      f.run({ url: `http://localhost:${portA}/hello` }, mkCtx('/')),
      (err: unknown) => err instanceof ModelFacingError && /private|blocked/i.test(err.message),
    );
  });

  test('invalid url / unsupported protocol → ModelFacingError', async () => {
    const f = makeFetchTool();
    await assert.rejects(f.run({ url: 'not a url' }, mkCtx('/')), (e: unknown) => e instanceof ModelFacingError);
    await assert.rejects(f.run({ url: 'file:///etc/passwd' }, mkCtx('/')), (e: unknown) => e instanceof ModelFacingError);
  });

  test('same-origin redirect keeps auth headers', async () => {
    const f = makeFetchTool(ALLOW);
    const out = await f.run(
      {
        url: `http://127.0.0.1:${portA}/r-same`,
        headers: { Authorization: 'Bearer sekrit', Cookie: 'sid=1', 'X-Api-Key': 'sekrit2' },
      },
      mkCtx('/'),
    );
    assert.ok(out.content.includes('Bearer sekrit'), `auth lost on same-origin hop: ${out.content}`);
    assert.ok(out.content.includes('sekrit2'), `custom header lost on same-origin hop: ${out.content}`);
  });

  test('cross-origin redirect strips ALL caller headers, custom auth included (security review #3)', async () => {
    const f = makeFetchTool(ALLOW);
    const out = await f.run(
      {
        url: `http://127.0.0.1:${portA}/r-cross`,
        headers: { Authorization: 'Bearer sekrit', Cookie: 'sid=1', 'X-Api-Key': 'sekrit2' },
      },
      mkCtx('/'),
    );
    assert.ok(!out.content.includes('sekrit'), `auth leaked cross-origin: ${out.content}`);
    assert.ok(!out.content.includes('sid=1'), `cookie leaked cross-origin: ${out.content}`);
    assert.ok(!out.content.includes('sekrit2'), `custom auth header leaked cross-origin: ${out.content}`);
    assert.ok(out.content.includes('"auth":null'), `expected stripped echo: ${out.content}`);
    assert.ok(out.content.includes('"key":null'), `expected stripped custom header echo: ${out.content}`);
  });

  test('redirect loops are cut off with a clear error', async () => {
    const f = makeFetchTool(ALLOW);
    await assert.rejects(
      f.run({ url: `http://127.0.0.1:${portA}/loop` }, mkCtx('/')),
      (err: unknown) => err instanceof ModelFacingError && /redirect/i.test(err.message),
    );
  });
});
