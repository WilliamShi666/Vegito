// P8 MCP client (DESIGN §8): a zero-dependency stdio JSON-RPC 2.0 client.
// Messages are newline-delimited JSON. The client performs the initialize
// handshake, lists tools, and adapts each remote tool into a ToolSpec under
// the "server::tool" namespace with deferred exposure (an MCP tool is not in
// the model's face until it reaches for it). tools/call results collapse their
// text content blocks into the ToolOut.content string.
//
// The transport seam keeps the protocol logic process-free for tests;
// spawnStdioTransport is the production transport over a child process.

import { spawn } from 'node:child_process';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../../tools/spec.ts';
import type { ToolSpec } from '../../tools/spec.ts';
import type { JsonSchema } from '../../lib/jsonschema.ts';

interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

export function encodeFrame(msg: RpcRequest): string {
  return `${JSON.stringify(msg)}\n`;
}

export function decodeFrames(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = buffer;
  for (;;) {
    const nl = rest.indexOf('\n');
    if (nl === -1) break;
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.trim() === '') continue;
    messages.push(JSON.parse(line));
  }
  return { messages, rest };
}

export interface McpTransport {
  onMessage(cb: (line: string) => void): void;
  send(line: string): void;
  close(): void;
}

interface RemoteTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: JsonSchema;
}

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
}

export class McpClient {
  readonly #server: string;
  readonly #transport: McpTransport;
  #buffer = '';
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(server: string, transport: McpTransport) {
    this.#server = server;
    this.#transport = transport;
    this.#transport.onMessage((line) => this.#onData(line));
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    const { messages, rest } = decodeFrames(this.#buffer);
    this.#buffer = rest;
    for (const msg of messages) {
      const m = msg as { id?: number; result?: unknown; error?: { message?: string } };
      if (typeof m.id !== 'number') continue;
      const pending = this.#pending.get(m.id);
      if (!pending) continue;
      this.#pending.delete(m.id);
      if (m.error) pending.reject(new Error(m.error.message ?? 'MCP error'));
      else pending.resolve(m.result);
    }
  }

  #call(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId++;
    const req: RpcRequest = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#transport.send(encodeFrame(req));
    });
  }

  async initialize(): Promise<void> {
    await this.#call('initialize', { protocolVersion: '1', capabilities: {} });
  }

  async listTools(): Promise<readonly ToolSpec[]> {
    const result = (await this.#call('tools/list')) as { tools?: RemoteTool[] };
    const tools = result.tools ?? [];
    return tools.map((t) => this.#adapt(t));
  }

  #adapt(remote: RemoteTool): ToolSpec {
    const qualified = `${this.#server}::${remote.name}`;
    return defineTool({
      name: qualified,
      description: remote.description ?? `MCP tool ${qualified}`,
      schema: remote.inputSchema ?? { type: 'object' },
      exposure: 'deferred',
      // MCP tools touch a remote server: network action, never auto-parallel.
      concurrencySafe: () => false,
      permissionKey: () => ({ tool: qualified, action: 'network', target: this.#server }),
      run: async (input) => {
        const result = (await this.#call('tools/call', { name: remote.name, arguments: input })) as {
          content?: Array<{ type?: string; text?: string }>;
          isError?: boolean;
        };
        const text = (result.content ?? [])
          .filter((b) => b.type === 'text' || b.text !== undefined)
          .map((b) => b.text ?? '')
          .join('\n');
        if (result.isError) throw new ModelFacingError(text === '' ? `MCP tool ${qualified} returned an error` : text);
        return { content: text };
      },
    });
  }

  close(): void {
    this.#transport.close();
    for (const p of this.#pending.values()) p.reject(new Error('MCP client closed'));
    this.#pending.clear();
  }
}

export function spawnStdioTransport(command: string, args: readonly string[]): McpTransport {
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'inherit'] });
  let cb: ((line: string) => void) | undefined;
  child.stdout.on('data', (d: Buffer) => cb?.(d.toString()));
  return {
    onMessage(handler) {
      cb = handler;
    },
    send(line) {
      child.stdin.write(line);
    },
    close() {
      child.kill();
    },
  };
}
