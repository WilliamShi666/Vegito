// Tool output budget (DESIGN §7.1): per-tool cap + per-message aggregate,
// middle-truncation that keeps head AND tail, and spill files so nothing is
// ever lost — the marker carries a read-back pointer the model can follow.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BudgetPolicy {
  readonly perToolChars: number;
  readonly perMessageChars: number;
  /** Smallest slice an output can be squeezed to; keeps the pointer visible. */
  readonly minFitChars?: number;
}

export const DEFAULT_BUDGET: BudgetPolicy = Object.freeze({
  perToolChars: 30_000,
  perMessageChars: 100_000,
  minFitChars: 256,
});

const FALLBACK_MIN_FIT = 256;

export interface FitResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly omittedChars: number;
  readonly spillPath?: string;
}

function marker(omitted: number, pointer?: string): string {
  const where = pointer === undefined ? '' : `; full output: ${pointer}`;
  return `\n[...${omitted} chars omitted${where}...]\n`;
}

export function truncateMiddle(text: string, cap: number, pointer?: string): FitResult {
  if (text.length <= cap) {
    return { content: text, truncated: false, omittedChars: 0 };
  }
  // Reserve marker space using the largest possible omitted count (the whole
  // text) so the real marker — always shorter or equal — is guaranteed to fit.
  const reserve = marker(text.length, pointer).length;
  const keep = Math.max(0, cap - reserve);
  const headLen = Math.ceil(keep / 2);
  const tailLen = Math.floor(keep / 2);
  const head = text.slice(0, headLen);
  const tail = tailLen === 0 ? '' : text.slice(-tailLen);
  const omitted = text.length - head.length - tail.length;
  const content = head + marker(omitted, pointer) + tail;
  return {
    content: content.length > cap ? content.slice(0, cap) : content, // tiny-cap last resort
    truncated: true,
    omittedChars: omitted,
  };
}

/** Persists full pre-truncation outputs under one directory, one file per call. */
export class SpillStore {
  readonly #dir: string;
  #ready: Promise<void> | undefined;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async spill(callId: string, text: string): Promise<string> {
    this.#ready ??= mkdir(this.#dir, { recursive: true }).then(() => undefined);
    await this.#ready;
    const safe = callId.replace(/[^A-Za-z0-9._-]/g, '_');
    const path = join(this.#dir, `${safe}.txt`);
    await writeFile(path, text, 'utf8');
    return path;
  }
}

/** One per assistant tool batch: charges every output against the message cap. */
export class MessageBudget {
  readonly #policy: BudgetPolicy;
  readonly #spill: SpillStore | undefined;
  #remaining: number;

  constructor(policy: BudgetPolicy, spill?: SpillStore) {
    this.#policy = policy;
    this.#spill = spill;
    this.#remaining = policy.perMessageChars;
  }

  async fit(callId: string, content: string): Promise<FitResult> {
    const floor = this.#policy.minFitChars ?? FALLBACK_MIN_FIT;
    const cap = Math.min(this.#policy.perToolChars, Math.max(floor, this.#remaining));
    if (content.length <= cap) {
      this.#remaining = Math.max(0, this.#remaining - content.length);
      return { content, truncated: false, omittedChars: 0 };
    }
    const spillPath = this.#spill === undefined ? undefined : await this.#spill.spill(callId, content);
    const fitted = truncateMiddle(content, cap, spillPath);
    this.#remaining = Math.max(0, this.#remaining - fitted.content.length);
    return spillPath === undefined ? fitted : { ...fitted, spillPath };
  }
}
