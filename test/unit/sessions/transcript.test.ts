import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createTranscript,
  openTranscript,
  forkTranscript,
} from '../../../src/sessions/transcript.ts';
import { fold, isHeader, isFork } from '../../../src/sessions/records.ts';
import type { NeutralMsg } from '../../../src/providers/types.ts';

function u(text: string): NeutralMsg {
  return { role: 'user', blocks: [{ kind: 'text', text }] };
}
function a(text: string): NeutralMsg {
  return { role: 'assistant', blocks: [{ kind: 'text', text }] };
}

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vegito-transcript-'));
}

test('createTranscript writes a v:1 header and starts empty', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 's1.jsonl');
    const t = await createTranscript(file, { sid: 's1', created: '2026-06-12T00:00:00.000Z', appVersion: '0.1.0' });
    assert.equal(t.sid, 's1');
    assert.deepEqual(t.messages(), []);
    const recs = t.records();
    assert.equal(recs.length, 1);
    assert.ok(isHeader(recs[0]!));
    const onDisk = (await readFile(file, 'utf8')).trim().split('\n');
    assert.equal(onDisk.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendMsg assigns monotonic seq + chained parent + unique ids', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 's.jsonl');
    const t = await createTranscript(file, { sid: 's', created: 'c', appVersion: 'v' });
    const m1 = await t.appendMsg(u('first'));
    const m2 = await t.appendMsg(a('second'));
    assert.equal(m2.seq, m1.seq + 1);
    assert.equal(m1.parent, null);
    assert.equal(m2.parent, m1.id);
    assert.notEqual(m1.id, m2.id);
    assert.deepEqual(t.messages(), [u('first'), a('second')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('re-open replays disk into the same state (replay == in-memory)', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 's.jsonl');
    const t = await createTranscript(file, { sid: 's', created: 'c', appVersion: 'v' });
    await t.appendMsg(u('m1'));
    await t.appendMsg(a('m2'));
    await t.appendMeta('latch_break', { reason: 'x' });
    await t.appendMsg(u('m3'));

    const re = await openTranscript(file);
    assert.equal(re.sid, 's');
    assert.deepEqual(re.records(), t.records());
    assert.deepEqual(re.messages(), t.messages());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendCompact folds the referenced range on replay', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 's.jsonl');
    const t = await createTranscript(file, { sid: 's', created: 'c', appVersion: 'v' });
    const m1 = await t.appendMsg(u('m1'));
    await t.appendMsg(a('m2'));
    const m3 = await t.appendMsg(u('m3'));
    await t.appendMsg(a('m4'));
    await t.appendCompact([m1.id, m3.id], a('SUMMARY'));

    assert.deepEqual(t.messages(), [a('SUMMARY'), a('m4')]);
    const re = await openTranscript(file);
    assert.deepEqual(re.messages(), [a('SUMMARY'), a('m4')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendMsg continues the seq/parent chain after re-open', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 's.jsonl');
    const t = await createTranscript(file, { sid: 's', created: 'c', appVersion: 'v' });
    const m1 = await t.appendMsg(u('m1'));
    const re = await openTranscript(file);
    const m2 = await re.appendMsg(a('m2'));
    assert.equal(m2.seq, m1.seq + 1);
    assert.equal(m2.parent, m1.id);
    assert.deepEqual((await openTranscript(file)).messages(), [u('m1'), a('m2')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('crash-cut trailing partial line is repaired on open, losing <=1 record', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 's.jsonl');
    const t = await createTranscript(file, { sid: 's', created: 'c', appVersion: 'v' });
    await t.appendMsg(u('m1'));
    await t.appendMsg(a('m2'));
    // simulate kill -9 mid-write: a half-written JSON line with no newline
    await appendFile(file, '{"seq":99,"id":"rX","parent":"', 'utf8');

    const re = await openTranscript(file);
    assert.deepEqual(re.messages(), [u('m1'), a('m2')]);
    // and the repaired file is append-ready again
    const m3 = await re.appendMsg(u('m3'));
    assert.equal(m3.parent, re.records()[re.records().length - 2]!.t === 'msg' ? (re.records()[re.records().length - 2] as { id: string }).id : m3.parent);
    assert.deepEqual((await openTranscript(file)).messages(), [u('m1'), a('m2'), u('m3')]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('forkTranscript creates a pointer file that shares zero message bytes with the parent', async () => {
  const dir = await tmp();
  try {
    const parentFile = join(dir, 'parent.jsonl');
    const parent = await createTranscript(parentFile, { sid: 'parent', created: 'c', appVersion: 'v' });
    await parent.appendMsg(u('SECRET-PARENT-MESSAGE'));
    const at = (await parent.appendMsg(a('another-parent-message'))).id;

    const forkFile = join(dir, 'child.jsonl');
    const child = await forkTranscript(forkFile, {
      sid: 'child',
      created: 'c2',
      appVersion: 'v',
      fromSid: 'parent',
      at,
    });
    const recs = child.records();
    assert.ok(isHeader(recs[0]!));
    assert.ok(isFork(recs[1]!));
    assert.equal(recs.length, 2);
    const fp = child.forkPointer();
    assert.equal(fp?.fromSid, 'parent');
    assert.equal(fp?.at, at);

    // pointer, not copy: none of the parent's message payloads live in the fork file
    const bytes = await readFile(forkFile, 'utf8');
    assert.ok(!bytes.includes('SECRET-PARENT-MESSAGE'));
    assert.ok(!bytes.includes('another-parent-message'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('50 scripted events: disk replay deep-equals in-memory fold', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 's.jsonl');
    const t = await createTranscript(file, { sid: 's', created: 'c', appVersion: 'v' });
    const liveIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      if (i > 0 && i % 17 === 0 && liveIds.length >= 2) {
        // compact the oldest two live entries
        const from = liveIds[0]!;
        const to = liveIds[1]!;
        const c = await t.appendCompact([from, to], a(`S@${i}`));
        liveIds.splice(0, 2, c.id);
      } else if (i % 5 === 0) {
        await t.appendMeta(`k${i}`, { i });
      } else {
        const m = await t.appendMsg(i % 2 === 0 ? u(`m${i}`) : a(`m${i}`));
        liveIds.push(m.id);
      }
    }
    const re = await openTranscript(file);
    assert.deepEqual(re.records(), t.records());
    assert.deepEqual(re.messages(), t.messages());
    assert.deepEqual(re.messages(), fold(t.records()));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('openTranscript throws on a missing header', async () => {
  const dir = await tmp();
  try {
    const file = join(dir, 'bad.jsonl');
    await writeFile(file, `${JSON.stringify({ seq: 0, id: 'r0', parent: null, t: 'msg', msg: u('x') })}\n`, 'utf8');
    await assert.rejects(() => openTranscript(file), /header/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
