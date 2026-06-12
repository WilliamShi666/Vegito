import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { agentTool } from '../../../../src/tools/builtin/agent.ts';
import { ModelFacingError } from '../../../../src/kernel/errors.ts';
import { mkCtx } from '../../../helpers/toolctx.ts';

describe('agent builtin (P3 stub)', () => {
  test('declares itself but stays hidden until orchestration lands (P9)', () => {
    assert.equal(agentTool.name, 'agent');
    assert.equal(agentTool.exposure, 'hidden');
  });

  test('invoking it is a clear, repairable refusal — not a crash', async () => {
    await assert.rejects(
      agentTool.run({ prompt: 'go do something' }, mkCtx('/')),
      (err: unknown) => err instanceof ModelFacingError && /not available|later phase|yet/i.test(err.message),
    );
  });
});
