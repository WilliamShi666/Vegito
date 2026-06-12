// P10 renderer (DESIGN §11): a pure fold from LoopEvent → display Frame. No
// terminal access, no state — the REPL appends what this returns, headless
// text mode prints it, and `--json` bypasses it. Tools never render (A4): the
// loop hands us the neutral ToolUIData side channel and we show a compact
// preview; we never call tool code. A null frame means "nothing to show".

import type { LoopEvent } from '../kernel/events.ts';
import type { Usage } from '../providers/types.ts';

export type Channel = 'text' | 'thinking' | 'tool' | 'ask' | 'notice' | 'meta';

export interface Frame {
  readonly channel: Channel;
  readonly text: string;
}

const MAX_INPUT_PREVIEW = 120;

// A one-line, bounded preview of arbitrary tool input — never executes it.
function previewInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > MAX_INPUT_PREVIEW ? `${s.slice(0, MAX_INPUT_PREVIEW - 1)}…` : s;
}

function usageText(u: Usage): string {
  return `${u.in} in / ${u.out} out`;
}

export function renderEvent(ev: LoopEvent): Frame | null {
  switch (ev.t) {
    case 'turn_start':
    case 'context':
      return null;
    case 'model_call':
      // The first attempt is the normal path and stays silent; retries matter.
      return ev.attempt > 1
        ? { channel: 'meta', text: `↻ retry ${ev.attempt} · ${ev.provider}/${ev.model}` }
        : null;
    case 'text_delta':
      return { channel: 'text', text: ev.text };
    case 'thinking_delta':
      return { channel: 'thinking', text: ev.text };
    case 'tool_start': {
      const preview = previewInput(ev.input);
      return { channel: 'tool', text: preview ? `⚙ ${ev.name} ${preview}` : `⚙ ${ev.name}` };
    }
    case 'tool_end':
      return ev.ok
        ? { channel: 'tool', text: `  ✓ ${ev.callId}` }
        : { channel: 'tool', text: `  ✗ ${ev.callId} failed` };
    case 'ask': {
      const head = `? ${ev.spec.title}`;
      if (ev.spec.kind === 'permission') {
        const opts = ev.spec.options.map((o) => `[${o.id}] ${o.label}`).join('  ');
        const detail = ev.spec.detail ? `\n  ${ev.spec.detail}` : '';
        return { channel: 'ask', text: `${head}${detail}\n  ${opts}` };
      }
      const ph = ev.spec.placeholder ? ` (${ev.spec.placeholder})` : '';
      return { channel: 'ask', text: `${head}${ph}` };
    }
    case 'compaction':
      return { channel: 'meta', text: `· compacted context (${ev.kind})` };
    case 'notice':
      return { channel: 'notice', text: `[${ev.level}] ${ev.text}` };
    case 'turn_end':
      return { channel: 'meta', text: `— ${ev.reason} · ${usageText(ev.usage)}` };
    default: {
      // Exhaustiveness: a new LoopEvent variant must add a case above.
      const _never: never = ev;
      return _never;
    }
  }
}
