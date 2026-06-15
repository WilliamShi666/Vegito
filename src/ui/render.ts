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
const MAX_ERROR_LINES = 10;

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

function normalizeToolError(error: string): string {
  const lines = error
    .split(/\r?\n/)
    .map((line) => line.trimEnd().replace(/^(?:ModelFacingError|Error):\s*/, ''))
    .filter((line) => line.trim() !== '' && !/^\s*at\s/.test(line) && !/\.js:\d+:\d+\)?$/.test(line));
  const kept = lines.slice(0, MAX_ERROR_LINES);
  const suffix = lines.length > kept.length ? [`... ${lines.length - kept.length} more line(s) hidden`] : [];
  return [...kept, ...suffix].join('\n');
}

function renderToolFailure(ev: Extract<LoopEvent, { t: 'tool_end' }>): Frame {
  const name = ev.name ?? ev.callId;
  if (ev.error === undefined || ev.error.trim() === '') {
    return { channel: 'tool', text: `Tool failed: ${name}` };
  }
  return { channel: 'tool', text: `Tool failed: ${name}\nReason: ${normalizeToolError(ev.error)}` };
}

function displayOption(id: string, fallback: string): string {
  if (id === 'allow') return '[a] allow';
  if (id === 'deny') return '[d] deny';
  return `[${id}] ${fallback}`;
}

function renderPermissionAsk(ev: Extract<LoopEvent, { t: 'ask' }>): Frame {
  const spec = ev.spec;
  if (spec.kind !== 'permission') return { channel: 'ask', text: `? ${spec.title}` };
  const header =
    spec.ordinal !== undefined && spec.total !== undefined
      ? `Permission request (Permission ${spec.ordinal}/${spec.total})`
      : 'Permission request';
  const lines = [header];
  if (spec.tool !== undefined) lines.push(`Tool: ${spec.tool}`);
  if (spec.action !== undefined) lines.push(`Action: ${spec.action}`);
  if (spec.target !== undefined) lines.push(`Target: ${spec.target}`);
  if (spec.detail !== undefined && spec.detail !== '') lines.push('', spec.detail);
  if (spec.tool === undefined && spec.action === undefined && spec.target === undefined) {
    lines.push(spec.title);
  }
  const opts = spec.options.map((o) => displayOption(o.id, o.label)).join('  ');
  lines.push('', `${opts}  [?] details`, 'permission>');
  return { channel: 'ask', text: lines.join('\n') };
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
      return ev.ok ? { channel: 'tool', text: `  ✓ ${ev.callId}` } : renderToolFailure(ev);
    case 'ask': {
      const head = `? ${ev.spec.title}`;
      if (ev.spec.kind === 'permission') {
        return renderPermissionAsk(ev);
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
