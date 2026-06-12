// P8 hooks (DESIGN §8): a 10-event bus over user executables. Contract:
// exit 0 = ok (stdout may inject context), exit 2 = block (stderr returned to
// the model), any other code = warn. Hooks fire in parallel per event with a
// hard timeout; results merge deny-wins (block > warn > allow). The runner is
// injectable so the bus logic is tested in isolation; a second test drives a
// real executable to pin the stdin/stdout/exit I/O schema.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyExit,
  createHookBus,
  loadHooksFile,
  HOOK_EVENTS,
  spawnHookRunner,
  type HookRunner,
  type HookSpec,
} from '../../../src/extend/hooks.ts';

test('HOOK_EVENTS lists the ten documented events', () => {
  assert.equal(HOOK_EVENTS.length, 10);
  assert.ok(HOOK_EVENTS.includes('PreToolUse'));
  assert.ok(HOOK_EVENTS.includes('PostCompact'));
});

test('classifyExit maps 0→allow with context, 2→block, other→warn', () => {
  assert.deepEqual(classifyExit(0, 'extra context', ''), { decision: 'allow', context: 'extra context' });
  assert.deepEqual(classifyExit(0, '', ''), { decision: 'allow' });
  assert.deepEqual(classifyExit(2, '', 'nope'), { decision: 'block', message: 'nope' });
  assert.deepEqual(classifyExit(137, '', 'crashed'), { decision: 'warn', message: 'crashed' });
});

function fakeRunner(table: Record<string, { code: number; stdout?: string; stderr?: string }>): HookRunner {
  return {
    run: async (spec) => {
      const r = table[spec.command] ?? { code: 0 };
      return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  };
}

test('dispatch returns allow when no hooks match the event', async () => {
  const bus = createHookBus([{ event: 'Stop', command: 'x' }], { runner: fakeRunner({}) });
  const out = await bus.dispatch('PreToolUse', { tool: 'read' });
  assert.equal(out.decision, 'allow');
});

test('dispatch collects injected context from allow hooks', async () => {
  const hooks: HookSpec[] = [
    { event: 'UserPromptSubmit', command: 'a' },
    { event: 'UserPromptSubmit', command: 'b' },
  ];
  const bus = createHookBus(hooks, {
    runner: fakeRunner({ a: { code: 0, stdout: 'CTX-A' }, b: { code: 0, stdout: 'CTX-B' } }),
  });
  const out = await bus.dispatch('UserPromptSubmit', {});
  assert.equal(out.decision, 'allow');
  assert.deepEqual([...out.contexts].sort(), ['CTX-A', 'CTX-B']);
});

test('dispatch merges deny-wins: one block among allows yields block', async () => {
  const hooks: HookSpec[] = [
    { event: 'PreToolUse', command: 'ok' },
    { event: 'PreToolUse', command: 'deny' },
  ];
  const bus = createHookBus(hooks, {
    runner: fakeRunner({ ok: { code: 0, stdout: 'c' }, deny: { code: 2, stderr: 'blocked: dangerous' } }),
  });
  const out = await bus.dispatch('PreToolUse', { tool: 'bash' });
  assert.equal(out.decision, 'block');
  assert.ok(out.messages.some((m) => m.includes('blocked: dangerous')));
});

test('dispatch matcher filters by payload.tool', async () => {
  const hooks: HookSpec[] = [{ event: 'PreToolUse', command: 'bashonly', matcher: 'bash' }];
  const bus = createHookBus(hooks, { runner: fakeRunner({ bashonly: { code: 2, stderr: 'no' } }) });
  const skipped = await bus.dispatch('PreToolUse', { tool: 'read' });
  assert.equal(skipped.decision, 'allow'); // matcher 'bash' != 'read' → hook skipped
  const fired = await bus.dispatch('PreToolUse', { tool: 'bash' });
  assert.equal(fired.decision, 'block');
});

test('dispatch treats a runner error/timeout as warn, never a crash', async () => {
  const runner: HookRunner = {
    run: async () => {
      throw new Error('spawn EACCES');
    },
  };
  const bus = createHookBus([{ event: 'Stop', command: 'broken' }], { runner });
  const out = await bus.dispatch('Stop', {});
  assert.equal(out.decision, 'warn');
  assert.ok(out.messages.some((m) => /spawn EACCES/.test(m)));
});

test('spawnHookRunner pins the real I/O schema: payload on stdin, exit/stderr honored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vg-hook-'));
  try {
    // A real executable: reads JSON from stdin, blocks the "rm" tool with exit 2.
    const script = join(dir, 'guard.sh');
    await writeFile(
      script,
      '#!/usr/bin/env bash\nread -r line\nif echo "$line" | grep -q \'"tool":"rm"\'; then\n  echo "rm is forbidden" >&2\n  exit 2\nfi\necho "ok-context"\nexit 0\n',
      'utf8',
    );
    await chmod(script, 0o755);
    const runner = spawnHookRunner({ timeoutMs: 5000 });
    const bus = createHookBus([{ event: 'PreToolUse', command: script }], { runner });

    const blocked = await bus.dispatch('PreToolUse', { tool: 'rm' });
    assert.equal(blocked.decision, 'block');
    assert.ok(blocked.messages.some((m) => m.includes('rm is forbidden')));

    const allowed = await bus.dispatch('PreToolUse', { tool: 'read' });
    assert.equal(allowed.decision, 'allow');
    assert.ok(allowed.contexts.some((c) => c.includes('ok-context')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawnHookRunner enforces the timeout, surfaced as warn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vg-hook-'));
  try {
    const script = join(dir, 'slow.sh');
    await writeFile(script, '#!/usr/bin/env bash\nsleep 5\n', 'utf8');
    await chmod(script, 0o755);
    const runner = spawnHookRunner({ timeoutMs: 100 });
    const bus = createHookBus([{ event: 'Stop', command: script }], { runner });
    const out = await bus.dispatch('Stop', {});
    assert.equal(out.decision, 'warn');
    assert.ok(out.messages.some((m) => /timed out/i.test(m)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadHooksFile: missing file is no hooks, not an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vg-hookfile-'));
  try {
    assert.deepEqual(await loadHooksFile(join(dir, 'hooks.json')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadHooksFile parses specs and resolves relative commands against the file dir', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vg-hookfile-'));
  try {
    const file = join(dir, 'hooks.json');
    await writeFile(
      file,
      JSON.stringify([
        { event: 'PreToolUse', command: './guard.sh', matcher: 'bash' },
        { event: 'Stop', command: '/usr/local/bin/audit' },
      ]),
      'utf8',
    );
    const specs = await loadHooksFile(file);
    assert.equal(specs.length, 2);
    assert.deepEqual(specs[0], { event: 'PreToolUse', command: join(dir, 'guard.sh'), matcher: 'bash' });
    assert.deepEqual(specs[1], { event: 'Stop', command: '/usr/local/bin/audit' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadHooksFile fails loud on malformed JSON and unknown events (hooks are guardrails)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vg-hookfile-'));
  try {
    const file = join(dir, 'hooks.json');
    await writeFile(file, '{ not json', 'utf8');
    await assert.rejects(() => loadHooksFile(file), (err: Error) => err.message.includes(file));

    await writeFile(file, JSON.stringify([{ event: 'BeforeToolUse', command: './x.sh' }]), 'utf8');
    await assert.rejects(() => loadHooksFile(file), /unknown event/);

    await writeFile(file, JSON.stringify([{ event: 'Stop' }]), 'utf8');
    await assert.rejects(() => loadHooksFile(file), /command/);

    await writeFile(file, JSON.stringify({ event: 'Stop', command: './x.sh' }), 'utf8');
    await assert.rejects(() => loadHooksFile(file), /array/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
