import { createHash } from 'node:crypto';

// Canonical JSON: byte-stable encoding with sorted object keys (SYNTHESIS A8).
// Identical values always produce identical strings, regardless of key insertion
// order — the foundation for cache-prefix hashing and latch identity (D4).

function encode(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined; // JSON.stringify semantics: dropped in objects, null in arrays
    case 'bigint':
      throw new TypeError('canonicalJson: cannot encode bigint');
    case 'object': {
      const obj = value as object;
      if (ancestors.has(obj)) throw new TypeError('canonicalJson: circular structure');
      ancestors.add(obj);
      try {
        if (Array.isArray(obj)) {
          const items = obj.map((item) => encode(item, ancestors) ?? 'null');
          return `[${items.join(',')}]`;
        }
        const keys = Object.keys(obj).sort();
        const parts: string[] = [];
        for (const key of keys) {
          const encoded = encode((obj as Record<string, unknown>)[key], ancestors);
          if (encoded !== undefined) parts.push(`${JSON.stringify(key)}:${encoded}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        ancestors.delete(obj);
      }
    }
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set()) ?? 'null';
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
