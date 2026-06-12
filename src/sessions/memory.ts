import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { NeutralMsg } from '../providers/types.ts';

// Two-level memory (DESIGN §4): per-project + global topic files under a
// `memory/` directory, one fact per file with frontmatter, indexed by a
// MEMORY.md pointer list. Extraction is cursor-based and advances only on
// success (the cc gap note: a failed extraction must not silently skip the
// turns it failed on). The four-type taxonomy and an explicit WHAT_NOT_TO_SAVE
// list are baked into the extraction prompt so the model classifies and filters
// at the source.

export const MEMORY_TYPES = Object.freeze(['user', 'feedback', 'project', 'reference'] as const);
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const WHAT_NOT_TO_SAVE: readonly string[] = Object.freeze([
  'Anything already recorded in the code, git history, or project config files.',
  'Transient details that only matter to the current task and not to future sessions.',
  'Secrets, credentials, API keys, tokens, or passwords — never persist these.',
  'Restatements of what the code structure already makes obvious.',
  'Speculation or facts you are not confident are true.',
]);

export interface Note {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const INDEX_FILE = 'MEMORY.md';

function assertName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid memory name "${name}": must be kebab-case [a-z0-9-], no path separators`);
  }
}

function isMemoryType(v: string): v is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(v);
}

// ---- note serialization --------------------------------------------------

export function renderNote(note: Note): string {
  assertName(note.name);
  if (!isMemoryType(note.type)) throw new Error(`invalid memory type "${note.type}"`);
  return [
    '---',
    `name: ${note.name}`,
    `description: ${note.description}`,
    `type: ${note.type}`,
    '---',
    '',
    note.body,
    '',
  ].join('\n');
}

export function parseNote(text: string): Note {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('note is missing frontmatter');
  const front = m[1]!;
  const body = m[2]!.replace(/^\n+/, '').replace(/\n+$/, '');
  const fields: Record<string, string> = {};
  for (const line of front.split('\n')) {
    const fm = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/.exec(line);
    if (fm) fields[fm[1]!] = fm[2]!;
  }
  const name = fields['name'] ?? '';
  const description = fields['description'] ?? '';
  const type = fields['type'] ?? '';
  assertName(name);
  if (!isMemoryType(type)) throw new Error(`invalid memory type "${type}"`);
  return { name, description, type, body };
}

// ---- extraction prompt ---------------------------------------------------

function messageText(msg: NeutralMsg): string {
  return msg.blocks
    .map((b) => (b.kind === 'text' || b.kind === 'thinking' ? b.text : b.kind === 'tool_result' ? b.content : ''))
    .filter((s) => s !== '')
    .join('\n');
}

export function buildExtractionPrompt(messages: readonly NeutralMsg[], existingNames: readonly string[]): string {
  const transcript = messages.map((m) => `[${m.role}] ${messageText(m)}`).join('\n');
  const types = MEMORY_TYPES.map((t) => `  - ${t}`).join('\n');
  const skip = WHAT_NOT_TO_SAVE.map((s) => `  - ${s}`).join('\n');
  const existing = existingNames.length ? existingNames.join(', ') : '(none yet)';
  return [
    'Extract durable memory notes from the conversation below.',
    '',
    'Classify each note as exactly one of these four types:',
    types,
    '',
    'DO NOT save any of the following:',
    skip,
    '',
    `Existing note names (update these instead of creating near-duplicates): ${existing}`,
    '',
    'Conversation:',
    transcript,
  ].join('\n');
}

// ---- on-disk store -------------------------------------------------------

export interface MemoryStore {
  save(note: Note): Promise<void>;
  read(name: string): Promise<Note | undefined>;
  remove(name: string): Promise<void>;
  names(): Promise<string[]>;
}

export function createMemoryStore(dir: string): MemoryStore {
  const noteFile = (name: string): string => {
    assertName(name);
    return join(dir, `${name}.md`);
  };

  async function listNotes(): Promise<Note[]> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const notes: Note[] = [];
    for (const f of files.sort()) {
      if (!f.endsWith('.md') || f === INDEX_FILE) continue;
      notes.push(parseNote(await readFile(join(dir, f), 'utf8')));
    }
    return notes;
  }

  async function rewriteIndex(): Promise<void> {
    const notes = await listNotes();
    const lines = ['# Memory Index', ''];
    for (const n of notes) lines.push(`- [${n.name}](${n.name}.md) — ${n.description}`);
    await writeFile(join(dir, INDEX_FILE), `${lines.join('\n')}\n`, 'utf8');
  }

  return {
    async save(note: Note): Promise<void> {
      await mkdir(dir, { recursive: true });
      await writeFile(noteFile(note.name), renderNote(note), 'utf8');
      await rewriteIndex();
    },

    async read(name: string): Promise<Note | undefined> {
      try {
        return parseNote(await readFile(noteFile(name), 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    },

    async remove(name: string): Promise<void> {
      try {
        await unlink(noteFile(name));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      await rewriteIndex();
    },

    async names(): Promise<string[]> {
      return (await listNotes()).map((n) => n.name);
    },
  };
}

// ---- cursor-based incremental extraction ---------------------------------

export interface ExtractorOpts {
  store: MemoryStore;
  extract: (prompt: string) => Promise<Note[]>;
}

export interface ExtractResult {
  cursor: number;
  saved: string[];
}

export interface Extractor {
  run(messages: readonly NeutralMsg[], cursor: number): Promise<ExtractResult>;
}

export function createExtractor(opts: ExtractorOpts): Extractor {
  return {
    async run(messages: readonly NeutralMsg[], cursor: number): Promise<ExtractResult> {
      // Already caught up: no model call, cursor unchanged (cheap and idempotent).
      if (cursor >= messages.length) return { cursor, saved: [] };

      const fresh = messages.slice(cursor);
      const prompt = buildExtractionPrompt(fresh, await opts.store.names());
      // If extraction throws, this propagates and the caller keeps the old
      // cursor — the same turns are retried next time (advances only on success).
      const notes = await opts.extract(prompt);
      const saved: string[] = [];
      for (const note of notes) {
        await opts.store.save(note);
        saved.push(note.name);
      }
      return { cursor: messages.length, saved };
    },
  };
}
