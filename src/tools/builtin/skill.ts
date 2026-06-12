// skill builtin (DESIGN §7.1): progressive disclosure. Tier 1 — the tool
// description carries every skill's name and one-liner, costing a few tokens
// per skill, always in context. Tier 2 — invoking the tool loads the full
// body into the transcript. The source is injected; P8's registry implements
// it from disk, tests stub it.

import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';
import type { ToolSpec } from '../spec.ts';

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
}

export interface SkillSource {
  list(): readonly SkillMeta[];
  load(name: string): Promise<string | undefined>;
}

export interface SkillIn {
  readonly name: string;
}

export function makeSkillTool(source: SkillSource): ToolSpec<SkillIn> {
  const metas = source.list();
  const catalog =
    metas.length === 0
      ? '(no skills installed)'
      : metas.map((m) => `- ${m.name}: ${m.description}`).join('\n');

  return defineTool<SkillIn>({
    name: 'skill',
    description:
      'Load a skill — expert instructions for a specific kind of task. Invoke BEFORE doing a ' +
      `task a skill covers. Available skills:\n${catalog}`,
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from the available list' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    permissionKey: (input) => ({ tool: 'skill', action: 'read', target: input.name }),
    run: async (input) => {
      const body = await source.load(input.name);
      if (body === undefined) {
        const names = metas.map((m) => m.name).join(', ');
        throw new ModelFacingError(
          `no skill named ${JSON.stringify(input.name)} — available: ${names === '' ? '(none)' : names}`,
        );
      }
      return { content: body };
    },
  });
}
