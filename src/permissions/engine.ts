// The permission engine (DESIGN §7.2): the ONE authorization point. Every
// tool call — builtin, MCP, pack, forge, evolution — passes through check().
// There is no second path and no in-process escalation: the mode is frozen at
// construction, the floor overrides everything (including bypass), and asks
// are the only way a verdict reaches a human.
//
// Decision order (first decisive rule wins):
//   1. hardline floor            → deny ALWAYS
//   2. explicit deny rule        → deny (beats every mode)
//   3. plan mode + non-read      → deny
//   4. bypass mode               → allow
//   5. rule tables (ask > allow) → that verdict
//   6. acceptEdits + in-ws write → allow
//   7. defaults                  → in-workspace read allow; outside read/write/execute/network ask
//
// For bash execute keys the floor scans the RAW command first (a backstop for
// patterns hidden from the tokenizer), then analyzeShell vets structure:
// unparseable ⇒ ask; otherwise each pipeline stage is matched independently
// and the pipeline's verdict is the worst stage. Write keys test workspace
// containment via the real (symlink-resolved) path.

import type { PermKey } from '../tools/spec.ts';
import type { PermissionMode } from '../config/schema.ts';
import { freezeMode, deniesNonReadActions, allowsWritesInWorkspace, bypassesRules } from './modes.ts';
import { matchRules, floorCheck } from './rules.ts';
import type { Rule, Verdict } from './rules.ts';
import { resolveWithin } from './paths.ts';
import { analyzeShell } from './shell.ts';
import { createAskBroker } from './ask.ts';
import type { AskBroker, OpenAsk } from './ask.ts';
import type { AskSpec } from '../kernel/events.ts';

export interface EngineOptions {
  readonly workspace: string;
  readonly mode: PermissionMode;
  readonly rules: readonly Rule[];
}

export type CheckResult = 'allow' | 'deny' | { readonly ask: OpenAsk<string> };

const BREAKER_CONSECUTIVE = 3;
const BREAKER_TOTAL = 20;
const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

export interface Engine {
  check(key: PermKey): Promise<CheckResult>;
  readonly broker: AskBroker<string>;
  readonly breakerTripped: boolean;
}

export function createEngine(options: EngineOptions): Engine {
  // Capture mode and workspace into private consts at construction — later
  // mutation of the caller's options object cannot widen privilege.
  const mode = freezeMode(options.mode);
  const workspace = options.workspace;
  const rules = [...options.rules];
  const broker = createAskBroker<string>();

  let consecutiveDenials = 0;
  let totalDenials = 0;

  const askFor = (key: PermKey): CheckResult => {
    const spec: AskSpec = {
      kind: 'permission',
      title: `Allow ${key.tool} (${key.action})${key.target === undefined ? '' : `: ${key.target}`}?`,
      options: [
        { id: 'allow', label: 'Allow' },
        { id: 'deny', label: 'Deny' },
      ],
    };
    return { ask: broker.open(spec) };
  };

  // The static portion of the decision, returning a Verdict. Asks and the
  // breaker are applied by check() around this.
  const decide = (key: PermKey): Verdict => {
    // 1. hardline floor — overrides everything, including bypass.
    if (floorCheck(key) !== undefined) return 'deny';

    if (key.action === 'execute' && key.tool === 'bash' && key.target !== undefined) {
      return decideBash(key.target);
    }
    return decideSimple(key);
  };

  const decideSimple = (key: PermKey): Verdict => {
    // 2. explicit deny rule beats modes.
    const ruled = matchRules(rules, key);
    if (ruled === 'deny') return 'deny';

    // 3. plan mode: nothing but reads.
    if (deniesNonReadActions(mode) && key.action !== 'read') return 'deny';

    // 4. bypass: skip rule tables (floor already cleared).
    if (bypassesRules(mode)) return 'allow';

    // 5. configurable rules (ask or allow; deny handled above).
    if (ruled !== undefined) return ruled;

    // 6. acceptEdits auto-allows in-workspace writes.
    if (key.action === 'write' && allowsWritesInWorkspace(mode) && key.target !== undefined) {
      if (resolveWithin(workspace, key.target).inside) return 'allow';
    }

    // 7. defaults: reads are only auto-allowed when workspace-contained.
    if (key.action === 'read') {
      if (key.target === undefined) return 'allow';
      return resolveWithin(workspace, key.target).inside ? 'allow' : 'ask';
    }
    return 'ask';
  };

  // A bash command is the worst verdict across its pipeline stages. The floor
  // already scanned the raw string in decide(); here we require the command to
  // be fully parseable (else ask) and match each stage's argv against rules.
  const decideBash = (command: string): Verdict => {
    const analysis = analyzeShell(command);
    if (!analysis.ok) {
      // Unparseable/dynamic: cannot be vetted. plan still denies; otherwise ask.
      if (deniesNonReadActions(mode)) return 'deny';
      return 'ask';
    }
    if (deniesNonReadActions(mode)) return 'deny';

    // Redirect-write targets are a write vector hiding inside an execute key.
    // Subject each to the same write-action floor a direct write would face,
    // so `echo x >> ~/.ssh/authorized_keys` cannot evade the credential floor.
    for (const stage of analysis.commands) {
      for (const target of stage.writes) {
        if (floorCheck({ tool: 'bash', action: 'write', target }) !== undefined) return 'deny';
      }
    }

    let worst: Verdict = 'allow';
    for (const stage of analysis.commands) {
      const stageKey: PermKey = { tool: 'bash', action: 'execute', target: stage.argv.join(' ') };
      const ruled = matchRules(rules, stageKey);
      let v: Verdict;
      if (ruled === 'deny') v = 'deny';
      else if (bypassesRules(mode)) v = 'allow';
      else if (ruled !== undefined) v = ruled;
      else v = 'ask'; // execute has no default-allow
      if (RANK[v] > RANK[worst]) worst = v;
    }
    return worst;
  };

  return {
    broker,
    get breakerTripped(): boolean {
      return consecutiveDenials >= BREAKER_CONSECUTIVE || totalDenials >= BREAKER_TOTAL;
    },
    async check(key: PermKey): Promise<CheckResult> {
      const verdict = decide(key);
      if (verdict === 'deny') {
        consecutiveDenials += 1;
        totalDenials += 1;
        return 'deny';
      }
      consecutiveDenials = 0;
      if (verdict === 'allow') return 'allow';
      return askFor(key);
    },
  };
}
