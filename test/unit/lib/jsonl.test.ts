import { test, describe, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile, writeFile, copyFile, truncate, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, scanJsonl, repairJsonl, JsonlCorruptionError } from '../../../src/lib/jsonl.ts';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vegito-jsonl-'));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('appendJsonl + scanJsonl', () => {
  test('appends one record per line and scans them back in order', async () => {
    const file = join(dir, 'basic.jsonl');
    await appendJsonl(file, { seq: 1, msg: 'hello' });
    await appendJsonl(file, { seq: 2, msg: '世界' });
    const { records, tail } = await scanJsonl(file);
    assert.deepEqual(records, [
      { seq: 1, msg: 'hello' },
      { seq: 2, msg: '世界' },
    ]);
    assert.equal(tail, null);
  });

  test('creates parent directories on first append', async () => {
    const file = join(dir, 'nested', 'deep', 'a.jsonl');
    await appendJsonl(file, { ok: true });
    const { records } = await scanJsonl(file);
    assert.deepEqual(records, [{ ok: true }]);
  });

  test('scan surfaces a partial trailing line as tail, not as a record', async () => {
    const file = join(dir, 'partial.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2,"trunc', 'utf8');
    const { records, tail } = await scanJsonl(file);
    assert.deepEqual(records, [{ a: 1 }]);
    assert.equal(tail, '{"b":2,"trunc');
  });

  test('scan accepts a final valid line missing its newline', async () => {
    const file = join(dir, 'no-eol.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}', 'utf8');
    const { records, tail } = await scanJsonl(file);
    assert.deepEqual(records, [{ a: 1 }, { b: 2 }]);
    assert.equal(tail, null);
  });

  test('scan throws JsonlCorruptionError on an invalid complete (mid-file) line', async () => {
    const file = join(dir, 'corrupt.jsonl');
    await writeFile(file, '{"a":1}\nnot json at all\n{"b":2}\n', 'utf8');
    await assert.rejects(scanJsonl(file), (err: unknown) => {
      assert.ok(err instanceof JsonlCorruptionError);
      assert.match((err as Error).message, /line 2/);
      return true;
    });
  });

  test('scan of an empty file yields no records and no tail', async () => {
    const file = join(dir, 'empty.jsonl');
    await writeFile(file, '', 'utf8');
    assert.deepEqual(await scanJsonl(file), { records: [], tail: null });
  });
});

describe('repairJsonl', () => {
  test('clean file: reports repaired=false and leaves bytes untouched', async () => {
    const file = join(dir, 'clean.jsonl');
    await appendJsonl(file, { a: 1 });
    const bytesBefore = await readFile(file);
    const out = await repairJsonl(file);
    assert.deepEqual(out, { repaired: false, tail: null });
    assert.deepEqual(await readFile(file), bytesBefore);
  });

  test('truncates a partial tail in place and returns it', async () => {
    const file = join(dir, 'tail.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2,"x', 'utf8');
    const out = await repairJsonl(file);
    assert.equal(out.repaired, true);
    assert.equal(out.tail, '{"b":2,"x');
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n');
  });

  test('normalizes a valid final line missing its newline', async () => {
    const file = join(dir, 'normalize.jsonl');
    await writeFile(file, '{"a":1}\n{"b":2}', 'utf8');
    const out = await repairJsonl(file);
    assert.deepEqual(out, { repaired: true, tail: null });
    assert.equal(await readFile(file, 'utf8'), '{"a":1}\n{"b":2}\n');
  });

  test('fuzz: any byte-truncation repairs to a parseable, append-ready file', async () => {
    const source = join(dir, 'fuzz-source.jsonl');
    const records = Array.from({ length: 20 }, (_, i) => ({
      seq: i,
      text: `record ${i} 测试数据 with ünïcode`,
      nested: { ok: i % 2 === 0, list: [i, i + 1] },
    }));
    for (const r of records) await appendJsonl(source, r);
    const total = (await stat(source)).size;
    const rnd = mulberry32(42);
    const cuts = new Set<number>([0, 1, total - 1, total]);
    while (cuts.size < 60) cuts.add(1 + Math.floor(rnd() * (total - 1)));

    for (const cut of cuts) {
      const file = join(dir, `fuzz-${cut}.jsonl`);
      await copyFile(source, file);
      await truncate(file, cut);
      await repairJsonl(file);

      // file now parses fully, all surviving records are an exact prefix
      const { records: got, tail } = await scanJsonl(file);
      assert.equal(tail, null, `cut=${cut} left a tail after repair`);
      assert.deepEqual(got, records.slice(0, got.length), `cut=${cut} corrupted a record`);

      // and the file is append-ready: a new record lands cleanly
      await appendJsonl(file, { seq: 'sentinel' });
      const after = await scanJsonl(file);
      assert.deepEqual(after.records, [...records.slice(0, got.length), { seq: 'sentinel' }], `cut=${cut} append broke`);
    }
  });
});
