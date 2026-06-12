import { test, describe, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBashTools } from '../../../../src/tools/builtin/bash.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';
import type { ToolCtx } from '../../../../src/tools/spec.ts';

const made: Array<{ dispose(): void }> = [];
function fresh() {
  const tools = makeBashTools();
  made.push(tools);
  return tools;
}
after(async () => {
  for (const t of made) t.dispose();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

describe('bash builtin', () => {
  test('declares itself: execute action targeting the command, serial; output tool is read-class', () => {
    const { bashTool, bashOutputTool } = fresh();
    assert.equal(bashTool.name, 'bash');
    assert.equal(bashTool.concurrencySafe({ command: 'ls' }), false);
    assert.deepEqual(bashTool.permissionKey({ command: 'rm -rf x' }), {
      tool: 'bash',
      action: 'execute',
      target: 'rm -rf x',
    });
    assert.equal(bashOutputTool.name, 'bash_output');
    assert.equal(bashOutputTool.concurrencySafe({ id: 'b1' }), true);
    assert.equal(bashOutputTool.permissionKey({ id: 'b1' }).action, 'read');
  });

  test('captures stdout', async () => {
    const { bashTool } = fresh();
    const out = await bashTool.run({ command: 'echo hello' }, mkCtx('/tmp'));
    assert.equal(out.content, 'hello');
  });

  test('runs in ctx.cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vegito-bash-'));
    try {
      const { bashTool } = fresh();
      const out = await bashTool.run({ command: 'pwd' }, mkCtx(dir));
      assert.equal(out.content, dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('stderr is captured and labeled', async () => {
    const { bashTool } = fresh();
    const out = await bashTool.run({ command: 'echo oops 1>&2' }, mkCtx('/tmp'));
    assert.ok(out.content.includes('oops'));
    assert.ok(out.content.includes('[stderr]'), `got: ${out.content}`);
  });

  test('nonzero exit is data, not an exception — model must see the code', async () => {
    const { bashTool } = fresh();
    const out = await bashTool.run({ command: 'echo partial; exit 3' }, mkCtx('/tmp'));
    assert.ok(out.content.includes('partial'));
    assert.ok(out.content.includes('exit code: 3'), `got: ${out.content}`);
  });

  test('empty output → explicit marker', async () => {
    const { bashTool } = fresh();
    const out = await bashTool.run({ command: 'true' }, mkCtx('/tmp'));
    assert.ok(out.content.includes('no output'), `got: ${out.content}`);
  });

  test('timeout kills the command and says so', async () => {
    const { bashTool } = fresh();
    const t0 = Date.now();
    const out = await bashTool.run({ command: 'sleep 30', timeout: 200 }, mkCtx('/tmp'));
    assert.ok(Date.now() - t0 < 5_000, 'must not wait for the sleep');
    assert.match(out.content, /timed out/i);
  });

  test('abort signal kills the command', async () => {
    const { bashTool } = fresh();
    const ac = new AbortController();
    const ctx: ToolCtx = { ...mkCtx('/tmp'), signal: ac.signal };
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const out = await bashTool.run({ command: 'sleep 30' }, ctx);
    assert.ok(Date.now() - t0 < 5_000, 'must not wait for the sleep');
    assert.match(out.content, /abort|cancel|kill/i);
  });

  test('background job: immediate id, output retrievable once exited', async () => {
    const { bashTool, bashOutputTool } = fresh();
    const t0 = Date.now();
    const started = await bashTool.run(
      { command: 'sleep 0.2; echo bg-done', background: true },
      mkCtx('/tmp'),
    );
    assert.ok(Date.now() - t0 < 2_000, 'background start must not block');
    const id = /\b(b\d+)\b/.exec(started.content)?.[1];
    assert.ok(id !== undefined, `no job id in: ${started.content}`);

    let final = '';
    for (let i = 0; i < 50; i++) {
      const peek = await bashOutputTool.run({ id }, mkCtx('/tmp'));
      final += peek.content;
      if (/exited/.test(peek.content)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(final.includes('bg-done'), `got: ${final}`);
    assert.match(final, /exited.*0|code 0/i);
  });

  test('bash_output for unknown id → ModelFacingError', async () => {
    const { bashOutputTool } = fresh();
    await assert.rejects(
      bashOutputTool.run({ id: 'b999' }, mkCtx('/tmp')),
      (err: unknown) => err instanceof ModelFacingError && err.message.includes('b999'),
    );
  });

  test('timeout kill reaches grandchildren, not just the shell (security review #5)', async () => {
    const { bashTool } = fresh();
    const t0 = Date.now();
    const out = await bashTool.run({ command: 'sleep 30 & echo CHILD:$!; wait', timeout: 300 }, mkCtx('/tmp'));
    assert.ok(Date.now() - t0 < 5_000, 'orphaned grandchildren must not hold the turn hostage via the stdio pipes');
    const pid = Number(/CHILD:(\d+)/.exec(out.content)?.[1]);
    assert.ok(Number.isInteger(pid) && pid > 1, `no child pid in: ${out.content}`);
    assert.ok(await waitGone(pid), `grandchild ${pid} survived the kill`);
  });

  test('foreground output is capped, keeping the tail (security review #4)', async () => {
    const { bashTool } = fresh();
    const out = await bashTool.run(
      { command: 'head -c 3000000 /dev/zero | tr "\\0" x; echo TAIL-END' },
      mkCtx('/tmp'),
    );
    assert.ok(out.content.length <= 1_100_000, `output not capped: ${out.content.length} chars`);
    assert.match(out.content, /overflow|dropped/i);
    assert.ok(out.content.includes('TAIL-END'), 'newest output must be kept');
  });

  test('background job buffer is capped, keeping the tail (security review #4)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vegito-bashcap-'));
    try {
      const { bashTool, bashOutputTool } = fresh();
      const started = await bashTool.run(
        { command: 'head -c 3000000 /dev/zero | tr "\\0" x; echo TAIL-END; touch done.flag', background: true },
        mkCtx(dir),
      );
      const id = /\b(b\d+)\b/.exec(started.content)?.[1];
      assert.ok(id !== undefined, `no job id in: ${started.content}`);
      for (let i = 0; i < 100 && !existsSync(join(dir, 'done.flag')); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 200)); // let the last pipe chunks land
      const peek = await bashOutputTool.run({ id }, mkCtx(dir));
      assert.ok(peek.content.length <= 1_100_000, `buffer not capped: ${peek.content.length} chars`);
      assert.match(peek.content, /overflow|dropped/i);
      assert.ok(peek.content.includes('TAIL-END'), 'newest output must be kept');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('dispose kills lingering background jobs and clears the job table', async () => {
    const tools = makeBashTools();
    const started = await tools.bashTool.run({ command: 'echo PID:$$; sleep 30', background: true }, mkCtx('/tmp'));
    const id = /\b(b\d+)\b/.exec(started.content)?.[1];
    assert.ok(id !== undefined);

    let pid = NaN;
    for (let i = 0; i < 50 && !Number.isInteger(pid); i++) {
      const peek = await tools.bashOutputTool.run({ id }, mkCtx('/tmp'));
      const m = /PID:(\d+)/.exec(peek.content);
      if (m !== null) pid = Number(m[1]);
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(Number.isInteger(pid), 'job never reported its pid');

    tools.dispose();
    assert.ok(await waitGone(pid), `job process ${pid} survived dispose`);
    await assert.rejects(
      tools.bashOutputTool.run({ id }, mkCtx('/tmp')),
      (err: unknown) => err instanceof ModelFacingError,
      'job table must be cleared on dispose (review H1)',
    );
  });
});
