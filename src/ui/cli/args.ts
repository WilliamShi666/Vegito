// P10 CLI arg parsing (DESIGN §11): pure argv → ParsedCommand, separate from
// dispatch so every shape is unit-testable. Unknown commands and missing
// required args become a typed 'error' node, never a throw — dispatch renders
// usage and exits 2. The `--script` flag on `run` selects the ScriptedWire
// (offline, deterministic): the seam that makes the whole CLI testable and
// drives forge's offline path later.

import type { PermissionMode } from '../../config/schema.ts';

const MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypass'];

export type ParsedCommand =
  | {
      readonly cmd: 'repl';
      readonly model?: string;
      readonly mode?: PermissionMode;
      readonly cwd?: string;
      readonly script?: string;
      readonly packs: readonly string[];
    }
  | {
      readonly cmd: 'run';
      readonly prompt: string;
      readonly json: boolean;
      readonly model?: string;
      readonly mode?: PermissionMode;
      readonly cwd?: string;
      readonly script?: string;
      readonly packs: readonly string[];
    }
  | {
      readonly cmd: 'sessions';
      readonly sub: 'list' | 'resume' | 'fork';
      readonly target?: string;
      readonly at?: string;
      readonly cwd?: string;
      readonly script?: string;
    }
  | { readonly cmd: 'packs'; readonly sub: 'list' | 'validate' | 'trust'; readonly path?: string; readonly cwd?: string }
  | {
      readonly cmd: 'forge';
      readonly offline: boolean;
      readonly archetype?: string;
      readonly domain?: string;
      readonly name?: string;
      readonly from?: string;
      readonly out?: string;
      readonly script?: string;
      readonly native: boolean;
    }
  | {
      readonly cmd: 'evolve';
      readonly sub: 'run' | 'revert' | 'eval';
      readonly pack: string;
      readonly session?: string;
      readonly mode?: PermissionMode;
      readonly script?: string;
      readonly candidate?: string;
      readonly evalCases?: string;
      readonly report?: string;
      readonly apply: boolean;
    }
  | { readonly cmd: 'version' }
  | { readonly cmd: 'help' }
  | { readonly cmd: 'error'; readonly message: string };

interface Flags {
  readonly values: Readonly<Record<string, string>>;
  readonly lists: Readonly<Record<string, readonly string[]>>;
  readonly bools: ReadonlySet<string>;
  readonly positionals: readonly string[];
}

const VALUE_FLAGS = new Set([
  'model',
  'mode',
  'cwd',
  'script',
  'p',
  'prompt',
  'archetype',
  'domain',
  'name',
  'from',
  'out',
  'session',
  'pack',
  'candidate',
  'eval-cases',
  'report',
]);
const BOOL_FLAGS = new Set(['json', 'offline', 'apply', 'native']);

function parseFlags(args: readonly string[]): Flags | { error: string } {
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const name = a.startsWith('--') ? a.slice(2) : a.slice(1);
      if (BOOL_FLAGS.has(name)) {
        bools.add(name);
      } else if (VALUE_FLAGS.has(name)) {
        const next = args[i + 1];
        if (next === undefined) return { error: `flag --${name} needs a value` };
        values[name] = next;
        lists[name] = [...(lists[name] ?? []), next];
        i += 1;
      } else {
        return { error: `unknown flag: ${a}` };
      }
    } else {
      positionals.push(a);
    }
  }
  return { values, lists, bools, positionals };
}

function asMode(raw: string | undefined): PermissionMode | undefined | { error: string } {
  if (raw === undefined) return undefined;
  return (MODES as readonly string[]).includes(raw) ? (raw as PermissionMode) : { error: `invalid --mode: ${raw}` };
}

// Conditionally include optional keys so exactOptionalPropertyTypes is honored.
function opt<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

export function parseArgs(argv: readonly string[]): ParsedCommand {
  const head = argv[0];
  if (head === '--version' || head === '-v' || head === 'version') return { cmd: 'version' };
  if (head === '--help' || head === '-h' || head === 'help') return { cmd: 'help' };
  if (head === undefined || head === 'repl' || head.startsWith('-')) {
    const f = parseFlags(argv.slice(head === 'repl' ? 1 : 0));
    if ('error' in f) return { cmd: 'error', message: f.error };
    const mode = asMode(f.values.mode);
    if (mode && typeof mode === 'object') return { cmd: 'error', message: mode.error };
    return {
      cmd: 'repl',
      ...opt('model', f.values.model),
      ...(mode ? { mode } : {}),
      ...opt('cwd', f.values.cwd),
      ...opt('script', f.values.script),
      packs: f.lists.pack ?? [],
    };
  }
  if (head === 'forge') {
    const f = parseFlags(argv.slice(1));
    if ('error' in f) return { cmd: 'error', message: f.error };
    return {
      cmd: 'forge',
      offline: f.bools.has('offline'),
      native: f.bools.has('native'),
      ...opt('archetype', f.values.archetype),
      ...opt('domain', f.values.domain),
      ...opt('name', f.values.name),
      ...opt('from', f.values.from),
      ...opt('out', f.values.out),
      ...opt('script', f.values.script),
    };
  }
  if (head === 'evolve') {
    const f = parseFlags(argv.slice(1));
    if ('error' in f) return { cmd: 'error', message: f.error };
    const sub = f.positionals[0] === 'revert' ? 'revert' : f.positionals[0] === 'eval' ? 'eval' : 'run';
    // Pack defaults to cwd: `evolve` operates on the pack you're standing in.
    const pack = (sub === 'revert' || sub === 'eval' ? f.positionals[1] : f.positionals[0]) ?? '.';
    const mode = asMode(f.values.mode);
    if (mode && typeof mode === 'object') return { cmd: 'error', message: mode.error };
    return {
      cmd: 'evolve',
      sub,
      pack,
      ...opt('session', f.values.session),
      ...(mode ? { mode } : {}),
      ...opt('script', f.values.script),
      ...opt('candidate', f.values.candidate),
      ...opt('evalCases', f.values['eval-cases']),
      ...opt('report', f.values.report),
      apply: f.bools.has('apply'),
    };
  }

  if (head === 'run') {
    const f = parseFlags(argv.slice(1));
    if ('error' in f) return { cmd: 'error', message: f.error };
    const prompt = f.values.prompt ?? f.values.p;
    if (prompt === undefined) return { cmd: 'error', message: 'run needs a prompt: -p "..."' };
    const mode = asMode(f.values.mode);
    if (mode && typeof mode === 'object') return { cmd: 'error', message: mode.error };
    return {
      cmd: 'run',
      prompt,
      json: f.bools.has('json'),
      ...opt('model', f.values.model),
      ...(mode ? { mode } : {}),
      ...opt('cwd', f.values.cwd),
      ...opt('script', f.values.script),
      packs: f.lists.pack ?? [],
    };
  }

  if (head === 'sessions') {
    const f = parseFlags(argv.slice(1));
    if ('error' in f) return { cmd: 'error', message: f.error };
    const sub = f.positionals[0] ?? 'list';
    if (sub !== 'list' && sub !== 'resume' && sub !== 'fork') return { cmd: 'error', message: `unknown sessions subcommand: ${sub}` };
    const target = f.positionals[1];
    const at = f.positionals[2];
    if (sub === 'resume' && target === undefined) return { cmd: 'error', message: 'sessions resume needs a session id' };
    if (sub === 'fork' && (target === undefined || at === undefined)) return { cmd: 'error', message: 'sessions fork needs <sid> <recordId>' };
    return { cmd: 'sessions', sub, ...opt('target', target), ...opt('at', at), ...opt('cwd', f.values.cwd), ...opt('script', f.values.script) };
  }

  if (head === 'packs') {
    const f = parseFlags(argv.slice(1));
    if ('error' in f) return { cmd: 'error', message: f.error };
    const sub = f.positionals[0] ?? 'list';
    if (sub !== 'list' && sub !== 'validate' && sub !== 'trust') return { cmd: 'error', message: `unknown packs subcommand: ${sub}` };
    const path = f.positionals[1];
    if (sub === 'validate' && path === undefined) return { cmd: 'error', message: 'packs validate needs a pack directory' };
    if (sub === 'trust' && path === undefined) return { cmd: 'error', message: 'packs trust needs a pack name or directory' };
    return { cmd: 'packs', sub, ...opt('path', path), ...opt('cwd', f.values.cwd) };
  }

  return { cmd: 'error', message: `unknown command: ${head}` };
}
