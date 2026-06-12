// Heuristic token estimator (DESIGN §7). Roughly 4 chars per token for
// Latin-script text; CJK ideographs, kana, and hangul run ≈1 token per
// character, so each counts as 4 units. Always an overestimate-friendly
// ceil — context budgeting must err toward compacting early, not late.

const CJK_RANGES = [
  [0x3000, 0x30ff], // CJK punctuation, hiragana, katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xac00, 0xd7af], // hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // full-width forms
] as const;

function isCjk(code: number): boolean {
  for (const [lo, hi] of CJK_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

export function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) {
    units += isCjk(ch.codePointAt(0) ?? 0) ? 4 : 1;
  }
  return Math.ceil(units / 4);
}
