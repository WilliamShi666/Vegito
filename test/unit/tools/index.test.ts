import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defineTool,
  ToolRegistry,
  RwGate,
  MessageBudget,
  DEFAULT_BUDGET,
  makeBuiltinTools,
} from '../../../src/tools/index.ts';
import type { BuiltinDeps } from '../../../src/tools/index.ts';

let dir = '';
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-barrel-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(): BuiltinDeps {
  return {
    memoryDir: join(dir, 'memory'),
    skills: { list: () => [], load: async () => undefined },
  };
}

describe('tools barrel', () => {
  test('re-exports the core pipeline pieces', () => {
    assert.equal(typeof defineTool, 'function');
    assert.equal(typeof ToolRegistry, 'function');
    assert.equal(typeof RwGate, 'function');
    assert.equal(typeof MessageBudget, 'function');
    assert.ok(DEFAULT_BUDGET.perToolChars > 0);
  });

  test('makeBuiltinTools yields the full launch set, registrable as one namespace', () => {
    const set = makeBuiltinTools(deps());
    const registry = new ToolRegistry();
    for (const tool of set.tools) registry.register(tool);

    const visible = registry.list().map((t) => t.name);
    assert.deepEqual(visible, [
      'bash',
      'bash_output',
      'edit',
      'fetch',
      'glob',
      'grep',
      'ls',
      'memory',
      'read',
      'skill',
      'todo',
      'write',
    ]);
    // No multi-agent deps supplied → no agent tool in the surface at all (P9).
    assert.equal(registry.get('agent'), undefined);
    assert.equal(registry.listAll().length, 12);
    set.dispose();
  });

  test('agent tool appears — direct, execute-class — only when multi-agent deps are supplied', () => {
    const set = makeBuiltinTools({
      ...deps(),
      agent: {
        spawner: { spawn: async (s) => ({ name: s.name, status: 'ok', content: '' }) },
        depth: 0,
        grants: ['read'],
      },
    });
    const registry = new ToolRegistry();
    for (const tool of set.tools) registry.register(tool);
    const agent = registry.get('agent');
    assert.ok(agent, 'agent tool should be present when deps.agent is supplied');
    assert.equal(agent!.exposure, 'direct');
    assert.equal(registry.listAll().length, 13);
    set.dispose();
  });

  test('same deps → identical surface hash (cache latch stability, D4)', () => {
    const a = new ToolRegistry();
    const b = new ToolRegistry();
    const setA = makeBuiltinTools(deps());
    const setB = makeBuiltinTools(deps());
    for (const t of setA.tools) a.register(t);
    for (const t of setB.tools) b.register(t);
    assert.equal(a.listHash(), b.listHash());
    setA.dispose();
    setB.dispose();
  });

  test('a different skill catalog changes the surface hash', () => {
    const a = new ToolRegistry();
    const b = new ToolRegistry();
    const setA = makeBuiltinTools(deps());
    const setB = makeBuiltinTools({
      ...deps(),
      skills: { list: () => [{ name: 'tdd', description: 'test first' }], load: async () => undefined },
    });
    for (const t of setA.tools) a.register(t);
    for (const t of setB.tools) b.register(t);
    assert.notEqual(a.listHash(), b.listHash());
    setA.dispose();
    setB.dispose();
  });
});
