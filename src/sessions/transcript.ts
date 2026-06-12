import { appendJsonl, scanJsonl, repairJsonl } from '../lib/jsonl.ts';
import { newId } from '../lib/ids.ts';
import type { NeutralMsg } from '../providers/types.ts';
import {
  type Rec,
  type MsgRec,
  type CompactRec,
  type ForkRec,
  type MetaRec,
  headerRec,
  msgRec,
  compactRec,
  forkRec,
  metaRec,
  isHeader,
  isFork,
  parseRec,
  fold,
} from './records.ts';

// Append-only JSONL transcript (DESIGN §4, L1). A Transcript owns one file and
// mirrors its records in memory; every append writes to disk and updates the
// mirror so `messages()` (the replay fold) is always consistent with what a
// fresh `openTranscript` would produce. Compaction appends a `compact` record
// (never deletes). Fork = a new file that opens with a `fork` pointer record
// referencing the parent sid + cut id — it copies zero parent bytes.

export interface Transcript {
  readonly sid: string;
  records(): readonly Rec[];
  messages(): NeutralMsg[];
  forkPointer(): { fromSid: string; at: string } | undefined;
  appendMsg(msg: NeutralMsg): Promise<MsgRec>;
  appendCompact(replaces: [string, string], summary: NeutralMsg): Promise<CompactRec>;
  appendMeta(k: string, p: unknown): Promise<MetaRec>;
}

export interface CreateOpts {
  sid: string;
  created: string;
  appVersion: string;
}

export interface ForkOpts extends CreateOpts {
  fromSid: string;
  at: string;
}

class FileTranscript implements Transcript {
  readonly sid: string;
  private readonly file: string;
  private readonly recs: Rec[];
  private lastSeq: number;
  private lastId: string | null;

  constructor(file: string, recs: Rec[]) {
    this.file = file;
    this.recs = recs;
    const header = recs[0];
    if (!header || !isHeader(header)) {
      throw new Error(`transcript ${file} is missing its v:1 header record`);
    }
    this.sid = header.sid;
    let seq = -1;
    let id: string | null = null;
    for (const r of recs) {
      if (!isHeader(r)) {
        seq = r.seq;
        id = r.id;
      }
    }
    this.lastSeq = seq;
    this.lastId = id;
  }

  records(): readonly Rec[] {
    return this.recs;
  }

  messages(): NeutralMsg[] {
    return fold(this.recs);
  }

  forkPointer(): { fromSid: string; at: string } | undefined {
    const f = this.recs.find((r): r is ForkRec => isFork(r));
    return f ? { fromSid: f.fromSid, at: f.at } : undefined;
  }

  private nextSeq(): number {
    this.lastSeq += 1;
    return this.lastSeq;
  }

  private async push(rec: Rec): Promise<void> {
    await appendJsonl(this.file, rec);
    this.recs.push(rec);
    if (!isHeader(rec)) this.lastId = rec.id;
  }

  async appendMsg(msg: NeutralMsg): Promise<MsgRec> {
    const rec = msgRec(this.nextSeq(), newId(), this.lastId, msg);
    await this.push(rec);
    return rec;
  }

  async appendCompact(replaces: [string, string], summary: NeutralMsg): Promise<CompactRec> {
    const rec = compactRec(this.nextSeq(), newId(), this.lastId, replaces, summary);
    await this.push(rec);
    return rec;
  }

  async appendMeta(k: string, p: unknown): Promise<MetaRec> {
    const rec = metaRec(this.nextSeq(), newId(), this.lastId, k, p);
    await this.push(rec);
    return rec;
  }
}

export async function createTranscript(file: string, opts: CreateOpts): Promise<Transcript> {
  const header = headerRec(opts.sid, opts.created, opts.appVersion);
  await appendJsonl(file, header);
  return new FileTranscript(file, [header]);
}

export async function forkTranscript(file: string, opts: ForkOpts): Promise<Transcript> {
  const header = headerRec(opts.sid, opts.created, opts.appVersion);
  const pointer = forkRec(0, newId(), null, opts.fromSid, opts.at);
  await appendJsonl(file, header);
  await appendJsonl(file, pointer);
  return new FileTranscript(file, [header, pointer]);
}

export async function openTranscript(file: string): Promise<Transcript> {
  // Crash tolerance: truncate a partial trailing line before replay (L1).
  await repairJsonl(file);
  const { records: raw } = await scanJsonl(file);
  const recs = raw.map(parseRec);
  return new FileTranscript(file, recs);
}
