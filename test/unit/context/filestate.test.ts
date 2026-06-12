import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { FileState } from '../../../src/context/filestate.ts';

describe('FileState', () => {
  test('unknown path → undefined (never read this session)', () => {
    const fs = new FileState();
    assert.equal(fs.seenAt('/a/b.ts'), undefined);
  });

  test('noteSeen → seenAt roundtrip; later notes win', () => {
    const fs = new FileState();
    fs.noteSeen('/a/b.ts', 1000);
    assert.equal(fs.seenAt('/a/b.ts'), 1000);
    fs.noteSeen('/a/b.ts', 2000);
    assert.equal(fs.seenAt('/a/b.ts'), 2000);
  });

  test('paths are independent', () => {
    const fs = new FileState();
    fs.noteSeen('/a.ts', 1);
    assert.equal(fs.seenAt('/b.ts'), undefined);
  });
});
