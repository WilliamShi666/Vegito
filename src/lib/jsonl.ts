import { appendFile, mkdir, readFile, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';

// JSONL with crash tolerance (DESIGN §4): append-only writes, scan that
// distinguishes a truncated tail from mid-file corruption, and an in-place
// repair that always leaves the file parseable and append-ready.

export class JsonlCorruptionError extends Error {
  readonly file: string;
  readonly line: number;

  constructor(file: string, line: number, snippet: string) {
    super(`invalid JSONL in ${file} at line ${line}: ${snippet.slice(0, 80)}`);
    this.name = 'JsonlCorruptionError';
    this.file = file;
    this.line = line;
  }
}

export async function appendJsonl(file: string, record: unknown): Promise<void> {
  const data = `${JSON.stringify(record)}\n`;
  try {
    await appendFile(file, data, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, data, 'utf8');
  }
}

export interface ScanResult {
  records: unknown[];
  tail: string | null; // unparseable trailing bytes (decoded lossily), null when clean
}

const NL = 0x0a;

export async function scanJsonl(file: string): Promise<ScanResult> {
  const buf = await readFile(file);
  const records: unknown[] = [];
  let start = 0;
  let line = 0;
  while (start < buf.length) {
    const nl = buf.indexOf(NL, start);
    if (nl === -1) {
      // final segment with no newline: a clean record that lost its newline, or a truncated tail
      const text = buf.subarray(start).toString('utf8');
      try {
        records.push(JSON.parse(text));
        return { records, tail: null };
      } catch {
        return { records, tail: text };
      }
    }
    line++;
    const text = buf.subarray(start, nl).toString('utf8');
    if (text.trim() !== '') {
      try {
        records.push(JSON.parse(text));
      } catch {
        // a complete line that is not JSON is real corruption, not truncation
        throw new JsonlCorruptionError(file, line, text);
      }
    }
    start = nl + 1;
  }
  return { records, tail: null };
}

export interface RepairResult {
  repaired: boolean;
  tail: string | null; // quarantined bytes removed from the file, if any
}

export async function repairJsonl(file: string): Promise<RepairResult> {
  const buf = await readFile(file);
  if (buf.length === 0 || buf[buf.length - 1] === NL) return { repaired: false, tail: null };
  const lastNl = buf.lastIndexOf(NL);
  const text = buf.subarray(lastNl + 1).toString('utf8');
  try {
    JSON.parse(text);
  } catch {
    await truncate(file, lastNl + 1);
    return { repaired: true, tail: text };
  }
  await appendFile(file, '\n', 'utf8'); // valid record, just missing its newline
  return { repaired: true, tail: null };
}
