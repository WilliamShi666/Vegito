import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { defineTool, type ToolCtx } from '../../../src/tools/spec.ts';
import { FileState } from '../../../src/context/filestate.ts';

const ctx: ToolCtx = { cwd: '/tmp', signal: new AbortController().signal, files: new FileState() };

describe('defineTool', () => {
  test('fail-closed defaults: direct exposure, serial, write-class ask', () => {
    const tool = defineTool({
      name: 'demo',
      description: 'a demo tool',
      schema: { type: 'object' },
      run: async () => ({ content: 'ok' }),
    });
    assert.equal(tool.exposure, 'direct');
    // L4: anything not declared read-safe is treated as a write
    assert.equal(tool.concurrencySafe({ any: 'input' }), false);
    // and routes to the gate as a target-less write (engine default: ask)
    assert.deepEqual(tool.permissionKey({ any: 'input' }), { tool: 'demo', action: 'write' });
  });

  test('explicit declarations override the defaults', () => {
    const tool = defineTool<{ path: string }>({
      name: 'reader',
      description: 'reads',
      schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      exposure: 'hidden',
      concurrencySafe: () => true,
      permissionKey: (input) => ({ tool: 'reader', action: 'read', target: input.path }),
      run: async (input) => ({ content: input.path }),
    });
    assert.equal(tool.exposure, 'hidden');
    assert.equal(tool.concurrencySafe({ path: 'x' }), true);
    assert.deepEqual(tool.permissionKey({ path: '/a/b' }), { tool: 'reader', action: 'read', target: '/a/b' });
  });

  test('run receives the input and ctx unchanged', async () => {
    const seen: unknown[] = [];
    const tool = defineTool<{ n: number }>({
      name: 't',
      description: 'd',
      schema: { type: 'object' },
      run: async (input, c) => {
        seen.push(input, c);
        return { content: String(input.n) };
      },
    });
    const out = await tool.run({ n: 7 }, ctx);
    assert.equal(out.content, '7');
    assert.deepEqual(seen, [{ n: 7 }, ctx]);
  });
});
