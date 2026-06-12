// Sessions (DESIGN §4, D3/D12) — append-only JSONL transcripts, replay-fold,
// fork-by-pointer, project-slug store, and cursor-based memory extraction.
export {
  RECORD_VERSION,
  FoldError,
  RecordParseError,
  headerRec,
  msgRec,
  compactRec,
  forkRec,
  metaRec,
  isHeader,
  isMsg,
  isCompact,
  isFork,
  isMeta,
  parseRec,
  fold,
} from './records.ts';
export type { Rec, HeaderRec, MsgRec, CompactRec, ForkRec, MetaRec } from './records.ts';

export { createTranscript, openTranscript, forkTranscript } from './transcript.ts';
export type { Transcript, CreateOpts, ForkOpts } from './transcript.ts';

export { createStore } from './store.ts';
export type { Store, StoreOpts, SessionSummary } from './store.ts';

export {
  MEMORY_TYPES,
  WHAT_NOT_TO_SAVE,
  renderNote,
  parseNote,
  buildExtractionPrompt,
  createMemoryStore,
  createExtractor,
} from './memory.ts';
export type { Note, MemoryType, MemoryStore, Extractor, ExtractorOpts, ExtractResult } from './memory.ts';
