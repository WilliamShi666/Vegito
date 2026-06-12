import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_TYPES,
  WHAT_NOT_TO_SAVE,
  renderNote,
  parseNote,
  buildExtractionPrompt,
  createMemoryStore,
  createExtractor,
  type Note,
} from '../../../src/sessions/memory.ts';
import type { NeutralMsg } from '../../../src/providers/types.ts';

function u(text: string): NeutralMsg {
  return { role: 'user', blocks: [{ kind: 'text', text }] };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vegito-memory-'));
}

const sample: Note = {
  name: 'prefers-typescript',
  description: 'User prefers TypeScript over JavaScript',
  type: 'user',
  body: 'The user has stated a strong preference for TypeScript on all new work.',
};

test('the taxonomy is exactly the four types', () => {
  assert.deepEqual([...MEMORY_TYPES], ['user', 'feedback', 'project', 'reference']);
});

test('WHAT_NOT_TO_SAVE is a non-empty guidance list', () => {
  assert.ok(WHAT_NOT_TO_SAVE.length >= 3);
  assert.ok(WHAT_NOT_TO_SAVE.every((s) => typeof s === 'string' && s.length > 0));
});

test('renderNote/parseNote round-trip', () => {
  const text = renderNote(sample);
  assert.match(text, /^---\n/);
  assert.match(text, /name: prefers-typescript/);
  assert.match(text, /type: user/);
  assert.deepEqual(parseNote(text), sample);
});

test('parseNote rejects an unknown type', () => {
  const bad = renderNote(sample).replace('type: user', 'type: nonsense');
  assert.throws(() => parseNote(bad), /type/i);
});

test('buildExtractionPrompt embeds the taxonomy, the exclusion list, and existing names', () => {
  const prompt = buildExtractionPrompt([u('remember I like TS')], ['existing-note']);
  for (const t of MEMORY_TYPES) assert.match(prompt, new RegExp(t));
  for (const w of WHAT_NOT_TO_SAVE) assert.ok(prompt.includes(w));
  assert.match(prompt, /existing-note/);
});

test('save creates <name>.md plus a single index line; re-save updates, never duplicates', async () => {
  const dir = await tmp();
  try {
    const store = createMemoryStore(dir);
    await store.save(sample);
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, ['MEMORY.md', 'prefers-typescript.md']);
    const index1 = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    assert.match(index1, /\[prefers-typescript\]\(prefers-typescript\.md\)/);

    await store.save({ ...sample, description: 'Updated description' });
    const index2 = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    assert.equal(index2.match(/prefers-typescript\.md/g)?.length, 1, 'index has exactly one line for the note');
    assert.match(index2, /Updated description/);
    assert.deepEqual((await store.read('prefers-typescript'))!.description, 'Updated description');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('remove deletes the file and its index line', async () => {
  const dir = await tmp();
  try {
    const store = createMemoryStore(dir);
    await store.save(sample);
    await store.save({ ...sample, name: 'keep-me', description: 'survivor' });
    await store.remove('prefers-typescript');
    assert.deepEqual(await store.names(), ['keep-me']);
    const index = await readFile(join(dir, 'MEMORY.md'), 'utf8');
    assert.ok(!index.includes('prefers-typescript'));
    assert.match(index, /keep-me/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('names() of an empty store is empty', async () => {
  const dir = await tmp();
  try {
    assert.deepEqual(await createMemoryStore(dir).names(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractor advances the cursor to the message count on success', async () => {
  const dir = await tmp();
  try {
    const store = createMemoryStore(dir);
    const calls: string[] = [];
    const extractor = createExtractor({
      store,
      extract: async (prompt: string) => {
        calls.push(prompt);
        return [sample];
      },
    });
    const msgs = [u('a'), u('b'), u('c')];
    const res = await extractor.run(msgs, 0);
    assert.equal(res.cursor, 3);
    assert.deepEqual(res.saved, ['prefers-typescript']);
    assert.deepEqual(await store.names(), ['prefers-typescript']);
    assert.equal(calls.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractor leaves the cursor unchanged when extraction fails (retry from same point)', async () => {
  const dir = await tmp();
  try {
    const store = createMemoryStore(dir);
    let attempts = 0;
    const extractor = createExtractor({
      store,
      extract: async () => {
        attempts++;
        if (attempts === 1) throw new Error('model timeout');
        return [sample];
      },
    });
    const msgs = [u('a'), u('b')];
    await assert.rejects(() => extractor.run(msgs, 0), /timeout/);
    assert.deepEqual(await store.names(), [], 'nothing saved on failure');

    // retry from the same cursor succeeds
    const res = await extractor.run(msgs, 0);
    assert.equal(res.cursor, 2);
    assert.deepEqual(await store.names(), ['prefers-typescript']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractor is a no-op when already caught up (no extract call)', async () => {
  const dir = await tmp();
  try {
    const store = createMemoryStore(dir);
    let called = 0;
    const extractor = createExtractor({
      store,
      extract: async () => {
        called++;
        return [];
      },
    });
    const msgs = [u('a'), u('b')];
    const res = await extractor.run(msgs, 2);
    assert.equal(res.cursor, 2);
    assert.deepEqual(res.saved, []);
    assert.equal(called, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extractor only feeds the model messages past the cursor', async () => {
  const dir = await tmp();
  try {
    const store = createMemoryStore(dir);
    let seen = '';
    const extractor = createExtractor({
      store,
      extract: async (prompt: string) => {
        seen = prompt;
        return [];
      },
    });
    const msgs = [u('OLD-already-extracted'), u('NEW-since-cursor')];
    await extractor.run(msgs, 1);
    assert.ok(seen.includes('NEW-since-cursor'));
    assert.ok(!seen.includes('OLD-already-extracted'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
