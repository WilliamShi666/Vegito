import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStore } from '../../../src/sessions/store.ts';
import type { NeutralMsg } from '../../../src/providers/types.ts';

function u(text: string): NeutralMsg {
  return { role: 'user', blocks: [{ kind: 'text', text }] };
}
function a(text: string): NeutralMsg {
  return { role: 'assistant', blocks: [{ kind: 'text', text }] };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vegito-store-'));
}

test('create lays the file under <root>/<project-slug>/<sid>.jsonl', async () => {
  const root = await tmp();
  try {
    const store = createStore({ root, appVersion: '0.1.0' });
    const t = await store.create('/home/ubuntu/projects/My App');
    const slugDirs = await readdir(root);
    assert.equal(slugDirs.length, 1);
    const files = await readdir(join(root, slugDirs[0]!));
    assert.deepEqual(files, [`${t.sid}.jsonl`]);
    // same project resolves to the same slug dir
    await store.create('/home/ubuntu/projects/My App');
    assert.equal((await readdir(root)).length, 1);
    assert.equal((await readdir(join(root, slugDirs[0]!))).length, 2);
    // a different project gets a different slug dir
    await store.create('/home/ubuntu/projects/Other');
    assert.equal((await readdir(root)).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume re-opens an existing session by sid', async () => {
  const root = await tmp();
  try {
    const store = createStore({ root, appVersion: 'v' });
    const project = '/work/proj';
    const t = await store.create(project);
    await t.appendMsg(u('hello'));
    await t.appendMsg(a('world'));

    const re = await store.resume(project, t.sid);
    assert.equal(re.sid, t.sid);
    assert.deepEqual(re.messages(), [u('hello'), a('world')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list returns one summary per session, newest first', async () => {
  const root = await tmp();
  try {
    const store = createStore({ root, appVersion: 'v' });
    const project = '/work/proj';
    const t1 = await store.create(project);
    await t1.appendMsg(u('first session msg'));
    const t2 = await store.create(project);
    await t2.appendMsg(u('second session msg'));
    await t2.appendMsg(a('reply'));

    const list = await store.list(project);
    assert.equal(list.length, 2);
    // newest (t2) first
    assert.equal(list[0]!.sid, t2.sid);
    assert.equal(list[1]!.sid, t1.sid);
    assert.equal(list[0]!.messageCount, 2);
    assert.equal(list[1]!.messageCount, 1);
    assert.match(list[0]!.preview, /second session msg/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list of a project with no sessions is empty', async () => {
  const root = await tmp();
  try {
    const store = createStore({ root, appVersion: 'v' });
    assert.deepEqual(await store.list('/never/used'), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fork(sid, at) creates a child that resolves parent context up to the cut', async () => {
  const root = await tmp();
  try {
    const store = createStore({ root, appVersion: 'v' });
    const project = '/work/proj';
    const parent = await store.create(project);
    await parent.appendMsg(u('p1'));
    const cut = await parent.appendMsg(a('p2'));
    await parent.appendMsg(u('p3-after-cut')); // must NOT appear in the fork

    const child = await store.fork(project, parent.sid, cut.id);
    await child.appendMsg(u('c1'));

    // the child's own file holds only its own messages
    assert.deepEqual(child.messages(), [u('c1')]);
    // but the store resolves the full conversation across the fork pointer
    const resolved = await store.resolve(project, child.sid);
    assert.deepEqual(resolved, [u('p1'), a('p2'), u('c1')]);
    assert.notEqual(child.sid, parent.sid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolve walks a two-level fork chain', async () => {
  const root = await tmp();
  try {
    const store = createStore({ root, appVersion: 'v' });
    const project = '/work/proj';
    const gp = await store.create(project);
    await gp.appendMsg(u('g1'));
    const gpCut = await gp.appendMsg(a('g2'));

    const parent = await store.fork(project, gp.sid, gpCut.id);
    await parent.appendMsg(u('p1'));
    const pCut = await parent.appendMsg(a('p2'));

    const child = await store.fork(project, parent.sid, pCut.id);
    await child.appendMsg(u('c1'));

    const resolved = await store.resolve(project, child.sid);
    assert.deepEqual(resolved, [u('g1'), a('g2'), u('p1'), a('p2'), u('c1')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resolve of a non-forked session equals its own messages', async () => {
  const root = await tmp();
  try {
    const store = createStore({ root, appVersion: 'v' });
    const project = '/work/proj';
    const t = await store.create(project);
    await t.appendMsg(u('only'));
    assert.deepEqual(await store.resolve(project, t.sid), [u('only')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
