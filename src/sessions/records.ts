import type { NeutralMsg, Block, Role } from '../providers/types.ts';

// Session transcript record algebra (DESIGN §4, D3/D12). One JSONL file per
// session is an append-only log of these records (L1). Compaction never
// deletes: it appends a `compact` record whose `replaces` tuple references the
// id-range it collapses. `fold` replays the log into the model-facing
// NeutralMsg[] by honoring those ranges — the single source of truth for what
// the model sees on resume.

export const RECORD_VERSION = 1;

export type HeaderRec = { v: 1; t: 'header'; sid: string; created: string; appVersion: string };
export type MsgRec = { seq: number; id: string; parent: string | null; t: 'msg'; msg: NeutralMsg };
export type CompactRec = {
  seq: number;
  id: string;
  parent: string | null;
  t: 'compact';
  replaces: [string, string];
  summary: NeutralMsg;
};
export type ForkRec = {
  seq: number;
  id: string;
  parent: string | null;
  t: 'fork';
  fromSid: string;
  at: string;
};
export type MetaRec = {
  seq: number;
  id: string;
  parent: string | null;
  t: 'meta';
  k: string;
  p: unknown;
};

export type Rec = HeaderRec | MsgRec | CompactRec | ForkRec | MetaRec;

export class FoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FoldError';
  }
}

export class RecordParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordParseError';
  }
}

// ---- constructors --------------------------------------------------------

export function headerRec(sid: string, created: string, appVersion: string): HeaderRec {
  return { v: 1, t: 'header', sid, created, appVersion };
}

export function msgRec(seq: number, id: string, parent: string | null, msg: NeutralMsg): MsgRec {
  return { seq, id, parent, t: 'msg', msg };
}

export function compactRec(
  seq: number,
  id: string,
  parent: string | null,
  replaces: [string, string],
  summary: NeutralMsg,
): CompactRec {
  return { seq, id, parent, t: 'compact', replaces, summary };
}

export function forkRec(
  seq: number,
  id: string,
  parent: string | null,
  fromSid: string,
  at: string,
): ForkRec {
  return { seq, id, parent, t: 'fork', fromSid, at };
}

export function metaRec(seq: number, id: string, parent: string | null, k: string, p: unknown): MetaRec {
  return { seq, id, parent, t: 'meta', k, p };
}

// ---- type guards ---------------------------------------------------------

export function isHeader(r: Rec): r is HeaderRec {
  return r.t === 'header';
}
export function isMsg(r: Rec): r is MsgRec {
  return r.t === 'msg';
}
export function isCompact(r: Rec): r is CompactRec {
  return r.t === 'compact';
}
export function isFork(r: Rec): r is ForkRec {
  return r.t === 'fork';
}
export function isMeta(r: Rec): r is MetaRec {
  return r.t === 'meta';
}

// ---- parse / validation --------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validNeutralMsg(v: unknown): v is NeutralMsg {
  if (!isObject(v)) return false;
  const role = v['role'] as Role;
  if (role !== 'user' && role !== 'assistant') return false;
  if (!Array.isArray(v['blocks'])) return false;
  return v['blocks'].every(validBlock);
}

function validBlock(v: unknown): v is Block {
  if (!isObject(v)) return false;
  switch (v['kind']) {
    case 'text':
    case 'thinking':
      return typeof v['text'] === 'string';
    case 'tool_call':
      return typeof v['callId'] === 'string' && typeof v['name'] === 'string';
    case 'tool_result':
      return typeof v['callId'] === 'string' && typeof v['ok'] === 'boolean' && typeof v['content'] === 'string';
    case 'image':
      return typeof v['mediaType'] === 'string' && typeof v['dataBase64'] === 'string';
    default:
      return false;
  }
}

function reqStr(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string') throw new RecordParseError(`record field ${k} must be a string`);
  return v;
}

function reqNum(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RecordParseError(`record field ${k} must be a number`);
  return v;
}

function reqParent(o: Record<string, unknown>): string | null {
  const v = o['parent'];
  if (v === null) return null;
  if (typeof v === 'string') return v;
  throw new RecordParseError('record field parent must be a string or null');
}

function reqMsg(o: Record<string, unknown>, k: string): NeutralMsg {
  const v = o[k];
  if (!validNeutralMsg(v)) throw new RecordParseError(`record field ${k} is not a valid NeutralMsg`);
  return v;
}

export function parseRec(value: unknown): Rec {
  if (!isObject(value)) throw new RecordParseError('record must be a JSON object');
  const t = value['t'];
  switch (t) {
    case 'header': {
      if (value['v'] !== RECORD_VERSION) {
        throw new RecordParseError(`unsupported record version ${String(value['v'])} (need ${RECORD_VERSION})`);
      }
      return headerRec(reqStr(value, 'sid'), reqStr(value, 'created'), reqStr(value, 'appVersion'));
    }
    case 'msg':
      return msgRec(reqNum(value, 'seq'), reqStr(value, 'id'), reqParent(value), reqMsg(value, 'msg'));
    case 'compact': {
      const replaces = value['replaces'];
      if (!Array.isArray(replaces) || replaces.length !== 2 || typeof replaces[0] !== 'string' || typeof replaces[1] !== 'string') {
        throw new RecordParseError('compact.replaces must be a [string, string] tuple');
      }
      return compactRec(
        reqNum(value, 'seq'),
        reqStr(value, 'id'),
        reqParent(value),
        [replaces[0], replaces[1]],
        reqMsg(value, 'summary'),
      );
    }
    case 'fork':
      return forkRec(reqNum(value, 'seq'), reqStr(value, 'id'), reqParent(value), reqStr(value, 'fromSid'), reqStr(value, 'at'));
    case 'meta':
      return metaRec(reqNum(value, 'seq'), reqStr(value, 'id'), reqParent(value), reqStr(value, 'k'), value['p']);
    default:
      throw new RecordParseError(`unknown record type ${String(t)}`);
  }
}

// ---- replay fold ---------------------------------------------------------

// Replay the append-only log into the model-facing NeutralMsg[]. Each live
// entry is keyed by the record id that produced it (a msg id, or a compact id
// for a summary). A compact collapses the contiguous id-range [from, to] —
// which may include earlier summaries — into its single summary message.
type Entry = { id: string; msg: NeutralMsg };

export function fold(recs: readonly Rec[]): NeutralMsg[] {
  const entries: Entry[] = [];
  for (const r of recs) {
    if (isMsg(r)) {
      entries.push({ id: r.id, msg: r.msg });
    } else if (isCompact(r)) {
      const [fromId, toId] = r.replaces;
      const from = entries.findIndex((e) => e.id === fromId);
      const to = entries.findIndex((e) => e.id === toId);
      if (from === -1) throw new FoldError(`compact ${r.id} replaces unknown start id ${fromId}`);
      if (to === -1) throw new FoldError(`compact ${r.id} replaces unknown end id ${toId}`);
      if (from > to) throw new FoldError(`compact ${r.id} has inverted range [${fromId}, ${toId}]`);
      entries.splice(from, to - from + 1, { id: r.id, msg: r.summary });
    }
    // header / fork / meta contribute nothing to the model-facing array
  }
  return entries.map((e) => e.msg);
}
