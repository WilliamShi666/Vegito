import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { newId } from '../lib/ids.ts';
import type { NeutralMsg } from '../providers/types.ts';
import {
  type Transcript,
  createTranscript,
  openTranscript,
  forkTranscript,
} from './transcript.ts';
import { isFork, fold, type Rec } from './records.ts';

// Session store (DESIGN §4). Maps a project directory → a slug subdirectory of
// the store root, holds one JSONL transcript per session, and resolves fork
// chains. A fork's own file holds only its post-cut records (fork-by-pointer);
// `resolve` walks the pointer to splice parent context up to the cut id ahead
// of the child's own messages. The global index is rebuildable from these
// files and never authoritative.

export interface StoreOpts {
  root: string;
  appVersion: string;
}

export interface SessionSummary {
  sid: string;
  messageCount: number;
  preview: string;
}

export interface Store {
  create(project: string): Promise<Transcript>;
  resume(project: string, sid: string): Promise<Transcript>;
  fork(project: string, sid: string, at: string): Promise<Transcript>;
  resolve(project: string, sid: string): Promise<NeutralMsg[]>;
  list(project: string): Promise<SessionSummary[]>;
}

function projectSlug(project: string): string {
  const base = project
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48);
  const hash = createHash('sha256').update(project).digest('hex').slice(0, 8);
  return base ? `${base}-${hash}` : hash;
}

function nowIso(): string {
  return new Date().toISOString();
}

function firstText(msg: NeutralMsg): string {
  for (const b of msg.blocks) {
    if (b.kind === 'text') return b.text;
  }
  return '';
}

// Fold a transcript's own records, but only up to and including `at` (a record
// id in this file). `at === null` folds the whole file.
function foldUpTo(recs: readonly Rec[], at: string | null): NeutralMsg[] {
  if (at === null) return fold(recs);
  const idx = recs.findIndex((r) => !isFork(r) && r.t !== 'header' && r.id === at);
  if (idx === -1) throw new Error(`fork cut id ${at} not found in transcript`);
  return fold(recs.slice(0, idx + 1));
}

export function createStore(opts: StoreOpts): Store {
  const root = opts.root;
  const appVersion = opts.appVersion;

  const slugDir = (project: string): string => join(root, projectSlug(project));
  const sidFile = (project: string, sid: string): string => join(slugDir(project), `${sid}.jsonl`);

  async function resolveUpTo(project: string, sid: string, at: string | null): Promise<NeutralMsg[]> {
    const t = await openTranscript(sidFile(project, sid));
    const ptr = t.forkPointer();
    const prefix = ptr ? await resolveUpTo(project, ptr.fromSid, ptr.at) : [];
    return prefix.concat(foldUpTo(t.records(), at));
  }

  return {
    async create(project: string): Promise<Transcript> {
      const sid = newId();
      return createTranscript(sidFile(project, sid), { sid, created: nowIso(), appVersion });
    },

    async resume(project: string, sid: string): Promise<Transcript> {
      return openTranscript(sidFile(project, sid));
    },

    async fork(project: string, sid: string, at: string): Promise<Transcript> {
      const childSid = newId();
      return forkTranscript(sidFile(project, childSid), {
        sid: childSid,
        created: nowIso(),
        appVersion,
        fromSid: sid,
        at,
      });
    },

    async resolve(project: string, sid: string): Promise<NeutralMsg[]> {
      return resolveUpTo(project, sid, null);
    },

    async list(project: string): Promise<SessionSummary[]> {
      let files: string[];
      try {
        files = await readdir(slugDir(project));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const sids = files.filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length));
      const summaries: SessionSummary[] = [];
      for (const sid of sids) {
        const t = await openTranscript(sidFile(project, sid));
        const msgs = t.messages();
        const first = msgs[0];
        summaries.push({
          sid,
          messageCount: msgs.length,
          preview: first ? firstText(first) : '',
        });
      }
      // sids are monotonic ULIDs: lexicographic descending == newest first.
      summaries.sort((x, y) => (x.sid < y.sid ? 1 : x.sid > y.sid ? -1 : 0));
      return summaries;
    },
  };
}
