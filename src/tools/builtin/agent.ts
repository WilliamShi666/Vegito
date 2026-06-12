// agent builtin: P3 placeholder for §9's subagent spawn surface. Hidden —
// never advertised to the model — until P9 replaces it with the real
// orchestrator. If something invokes it anyway, the refusal is repairable.

import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';

export interface AgentIn {
  readonly prompt: string;
}

export const agentTool = defineTool<AgentIn>({
  name: 'agent',
  description: 'Spawn a subagent to handle a delegated task (not available yet).',
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Task for the subagent' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  exposure: 'hidden',
  run: async () => {
    throw new ModelFacingError('subagents are not available yet — multi-agent orchestration arrives in a later phase');
  },
});
