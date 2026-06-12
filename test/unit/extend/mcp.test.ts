// P8 MCP client (DESIGN §8): a zero-dependency stdio JSON-RPC 2.0 client.
// Newline-delimited messages over a child's stdin/stdout. After initialize +
// tools/list, each remote tool surfaces as a ToolSpec named "server::tool"
// with deferred exposure. The transport is injectable so the protocol logic is
// tested without a process; a second test drives a real node subprocess to pin
// the newline framing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { encodeFrame, decodeFrames, McpClient, type McpTransport } from '../../../src/extend/mcp/client.ts';

test('encodeFrame appends a newline; decodeFrames splits on newlines and buffers partials', () => {
  assert.equal(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' }), '{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const { messages, rest } = decodeFrames('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":');
});

// A scripted transport that answers initialize, tools/list, and tools/call.
function scriptedTransport(): McpTransport & { sent: string[] } {
  const sent: string[] = [];
  let onMessage: ((line: string) => void) | undefined;
  return {
    sent,
    onMessage(cb) {
      onMessage = cb;
    },
    send(line: string) {
      sent.push(line);
      const msg = JSON.parse(line) as { id?: number; method?: string };
      queueMicrotask(() => {
        if (msg.method === 'initialize') {
          onMessage?.(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '1' } }) + '\n');
        } else if (msg.method === 'tools/list') {
          onMessage?.(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                tools: [
                  { name: 'search', description: 'Web search', inputSchema: { type: 'object', properties: {} } },
                ],
              },
            }) + '\n',
          );
        } else if (msg.method === 'tools/call') {
          onMessage?.(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'RESULT' }] } }) + '\n',
          );
        }
      });
    },
    close() {},
  };
}

test('McpClient.initialize + listTools surfaces server::tool with deferred exposure', async () => {
  const client = new McpClient('brave', scriptedTransport());
  await client.initialize();
  const tools = await client.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.name, 'brave::search');
  assert.equal(tools[0]?.exposure, 'deferred');
  assert.equal(tools[0]?.description, 'Web search');
});

test('McpClient tool.run issues tools/call and returns the text content', async () => {
  const client = new McpClient('brave', scriptedTransport());
  await client.initialize();
  const [tool] = await client.listTools();
  assert.ok(tool);
  const out = await tool.run({ q: 'hi' }, { cwd: '/', signal: new AbortController().signal, files: {} as never });
  assert.equal(out.content, 'RESULT');
});

test('McpClient rejects a JSON-RPC error response', async () => {
  const transport: McpTransport = {
    onMessage(cb) {
      this._cb = cb;
    },
    send(line: string) {
      const msg = JSON.parse(line) as { id?: number };
      queueMicrotask(() =>
        (this._cb as (l: string) => void)?.(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\n',
        ),
      );
    },
    close() {},
  } as McpTransport & { _cb?: (l: string) => void };
  const client = new McpClient('x', transport);
  await assert.rejects(client.initialize(), /method not found/);
});

test('McpClient over a real stdio subprocess (newline framing end-to-end)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vg-mcp-'));
  try {
    // Minimal stdio MCP server: reads JSON-RPC lines, answers initialize/list/call.
    const server = join(dir, 'server.mjs');
    await writeFile(
      server,
      [
        'let buf = "";',
        'process.stdin.on("data", (d) => {',
        '  buf += d.toString();',
        '  let i;',
        '  while ((i = buf.indexOf("\\n")) >= 0) {',
        '    const line = buf.slice(0, i); buf = buf.slice(i + 1);',
        '    if (!line.trim()) continue;',
        '    const msg = JSON.parse(line);',
        '    let result;',
        '    if (msg.method === "initialize") result = { protocolVersion: "1" };',
        '    else if (msg.method === "tools/list") result = { tools: [{ name: "ping", description: "p", inputSchema: { type: "object" } }] };',
        '    else if (msg.method === "tools/call") result = { content: [{ type: "text", text: "pong" }] };',
        '    else result = {};',
        '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");',
        '  }',
        '});',
      ].join('\n'),
      'utf8',
    );
    const { spawnStdioTransport } = await import('../../../src/extend/mcp/client.ts');
    const transport = spawnStdioTransport('node', [server]);
    const client = new McpClient('echo', transport);
    await client.initialize();
    const [tool] = await client.listTools();
    assert.equal(tool?.name, 'echo::ping');
    const out = await tool!.run({}, { cwd: '/', signal: new AbortController().signal, files: {} as never });
    assert.equal(out.content, 'pong');
    client.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
