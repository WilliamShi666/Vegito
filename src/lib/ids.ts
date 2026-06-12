import { randomBytes } from 'node:crypto';

// ULID-style ids: 48-bit ms timestamp + 80-bit randomness, Crockford base32.
// Lexicographic order == creation order; same-millisecond ids increment the
// random part so they stay strictly monotonic (transcript seq, callIds, sids).

export const CROCKFORD32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const RAND_MAX = 1n << 80n;

function encodeBase32(value: bigint, chars: number): string {
  let v = value;
  const out = new Array<string>(chars);
  for (let i = chars - 1; i >= 0; i--) {
    out[i] = CROCKFORD32[Number(v & 31n)] as string;
    v >>= 5n;
  }
  return out.join('');
}

function randomBigInt80(): bigint {
  return BigInt(`0x${randomBytes(10).toString('hex')}`);
}

let lastMs = -1;
let lastRand = 0n;

export function newId(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    lastRand = randomBigInt80();
  } else {
    // same ms (or clock skew backwards): bump randomness to preserve monotonicity
    lastRand += 1n;
    if (lastRand >= RAND_MAX) throw new Error('newId: randomness overflow within one millisecond');
  }
  return encodeBase32(BigInt(lastMs), 10) + encodeBase32(lastRand, 16);
}
