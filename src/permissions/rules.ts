// Permission rules (DESIGN §7.2): two layers, both pure functions.
//
//   matchRules — user/pack-configurable pattern tables. A rule matches a
//   PermKey by tool ('*' wildcard), optional action, optional target glob
//   (* spans anything, all other characters literal, anchored both ends).
//   When several rules match, the most restrictive verdict wins:
//   deny > ask > allow.
//
//   floorCheck — the hardline floor. A short, auditable list of catastrophes
//   (root deletion, fork bombs, disk destruction, credential exfiltration,
//   system credential files) that NO rule and NO mode may override; the
//   engine checks it first and denies on a hit even in bypass mode. Command
//   floors run on the RAW string before tokenization, so obfuscation that
//   defeats the tokenizer ($IFS games) still trips either the floor or the
//   tokenizer's own fail-closed ask.

import type { PermKey } from '../tools/spec.ts';

export type Verdict = 'allow' | 'ask' | 'deny';

export interface Rule {
  readonly tool: string | '*';
  readonly action?: PermKey['action'];
  readonly target?: string;
  readonly verdict: Verdict;
}

export interface FloorHit {
  readonly name: string;
  readonly reason: string;
}

const RANK: Record<Verdict, number> = { allow: 0, ask: 1, deny: 2 };

function globToRegex(pattern: string): RegExp {
  let source = '';
  for (const ch of pattern) {
    source += ch === '*' ? '.*' : ch.replace(/[.+?^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Match a key against a rule table; most restrictive verdict wins. */
export function matchRules(rules: readonly Rule[], key: PermKey): Verdict | undefined {
  let worst: Verdict | undefined;
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== key.tool) continue;
    if (rule.action !== undefined && rule.action !== key.action) continue;
    if (rule.target !== undefined) {
      if (key.target === undefined) continue;
      if (!globToRegex(rule.target).test(key.target)) continue;
    }
    if (worst === undefined || RANK[rule.verdict] > RANK[worst]) worst = rule.verdict;
  }
  return worst;
}

// --- the hardline floor -----------------------------------------------------

// Targets whose recursive+forced removal is unrecoverable: /, /*, the home
// directory, or a top-level system directory.
const ROOTISH =
  String.raw`(?:\/\*?|~\/?|\$HOME\/?|\/(?:etc|usr|var|home|boot|bin|sbin|lib|lib64|opt|root|srv|sys|proc|dev)\/?\*?)`;
const ROOTISH_TOKEN = new RegExp(String.raw`(^|\s)${ROOTISH}(\s|$)`);

function rmRootHit(cmd: string): boolean {
  const m = /\brm\b([^|;&]*)/.exec(cmd);
  if (m === null) return false;
  const rest = m[1] ?? '';
  const recursive = /(^|\s)-(?:[a-zA-Z]*r|-recursive)/i.test(rest);
  const force = /(^|\s)-(?:[a-zA-Z]*f|-force)/.test(rest);
  return recursive && force && ROOTISH_TOKEN.test(rest);
}

const NET_TOOL = /(^|[\s;|&])(?:curl|wget|nc|ncat|netcat|scp|sftp|rsync|ftp)\b/;
const CRED_PATH =
  /(?:\.ssh\/id_[A-Za-z0-9_.]+|\.ssh\/authorized_keys|\.aws\/credentials|\/etc\/shadow|\/etc\/sudoers(?:\.d\/.*)?|\.gnupg\/|\.netrc\b|\.docker\/config\.json)/;

interface CommandFloor {
  readonly name: string;
  readonly reason: string;
  readonly hit: (cmd: string) => boolean;
}

const COMMAND_FLOOR: readonly CommandFloor[] = [
  {
    name: 'rm-root',
    reason: 'recursive forced deletion of the filesystem root, home, or a system directory',
    hit: rmRootHit,
  },
  {
    name: 'fork-bomb',
    reason: 'fork bomb — exhausts the process table and freezes the machine',
    hit: (cmd) => /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd),
  },
  {
    name: 'mkfs',
    reason: 'formatting a filesystem destroys all data on the device',
    hit: (cmd) => /\bmkfs(?:\.[a-z0-9]+)?\b/.test(cmd),
  },
  {
    name: 'dd-block-device',
    reason: 'dd writing directly to a block device destroys its contents',
    hit: (cmd) => /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|hd|nvme|vd|xvd|mmcblk|loop)/.test(cmd),
  },
  {
    name: 'block-device-write',
    reason: 'redirecting output onto a block device destroys its contents',
    hit: (cmd) => />\s*\/dev\/(?:sd|hd|nvme|vd|xvd|mmcblk)/.test(cmd),
  },
  {
    name: 'chmod-root',
    reason: 'recursive world-writable permissions on / breaks system security',
    hit: (cmd) => /\bchmod\b[^|;&]*-[a-zA-Z]*R[^|;&]*\b(?:777|a\+rwx)\s+\/\s*(?:$|[;|&])/.test(cmd),
  },
  {
    name: 'credential-exfil',
    reason: 'a network tool and a credential file in the same command — likely exfiltration',
    hit: (cmd) => NET_TOOL.test(cmd) && CRED_PATH.test(cmd),
  },
  {
    name: 'tee-credential-file',
    reason: 'tee writing a system credential file changes who can log in (the path is an argument, not a redirect, so the redirect-write floor never sees it)',
    hit: (cmd) => /\btee\b/.test(cmd) && (CRED_PATH.test(cmd) || /\/etc\/passwd\b/.test(cmd)),
  },
];

// Files that define identity, privilege, or provider credentials. Writes are
// floor for every write-action key; reads are floor for credential material.
const SYSTEM_CRED_FILE = /(?:^\/etc\/(?:passwd|shadow|sudoers(?:\.d\/.*)?)$|(?:^|\/)\.ssh\/authorized_keys$)/;
const READ_CRED_PATH =
  /(?:^\/etc\/(?:shadow|sudoers(?:\.d\/.*)?)$|(?:^|\/)\.ssh\/id_[A-Za-z0-9_.]+$|(?:^|\/)\.aws\/credentials$|(?:^|\/)\.netrc$|(?:^|\/)\.docker\/config\.json$|(?:^|\/)\.gnupg(?:\/|$))/;

/**
 * The hardline floor: returns a hit for catastrophic keys that nothing may
 * override (checked before rules and modes; deny even in bypass).
 */
export function floorCheck(key: PermKey): FloorHit | undefined {
  if (key.target === undefined) return undefined;
  if (key.action === 'execute') {
    for (const floor of COMMAND_FLOOR) {
      if (floor.hit(key.target)) return { name: floor.name, reason: floor.reason };
    }
    return undefined;
  }
  if (key.action === 'write' && SYSTEM_CRED_FILE.test(key.target)) {
    return {
      name: 'system-credential-file',
      reason: 'writing a system credential file (passwd/shadow/sudoers/authorized_keys) changes who can log in',
    };
  }
  if (key.action === 'read' && READ_CRED_PATH.test(key.target)) {
    return {
      name: 'credential-read',
      reason: 'reading credential material is never auto-authorized',
    };
  }
  return undefined;
}
