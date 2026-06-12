// fetch builtin (DESIGN §7.1): network read with two hard safety rails.
// (1) SSRF guard: the target host — and every redirect hop — must not be a
//     private/loopback/link-local address; hostnames are resolved and ALL
//     answers checked, failing closed. IPv6 literals are expanded to group
//     arithmetic so every IPv4-mapped notation hits the same v4 check.
//     (Known limit: a DNS-rebinding race between our lookup and the socket
//     connect remains; pinning the resolved address into the dispatcher is
//     P14 hardening.)
// (2) Credential hygiene: ALL caller headers are dropped when a redirect
//     crosses an origin boundary — custom auth schemes leak like standard
//     ones, so nothing carries over.
// Status codes are data, not exceptions — the model self-repairs (L9).

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ModelFacingError } from '../../kernel/errors.ts';
import { defineTool } from '../spec.ts';
import type { ToolSpec } from '../spec.ts';

export interface FetchIn {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface FetchOpts {
  /** Hostnames exempt from the private-address block (e.g. a local dev server). */
  readonly allowHosts?: readonly string[];
}

const MAX_REDIRECTS = 5;
const MAX_TEXT_CHARS = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a, b] = [parts[0] ?? -1, parts[1] ?? -1];
  if (a === 0) return true; // 0.0.0.0/8 "this network" — connects to localhost
  if (a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
  return false;
}

/**
 * Expand an IPv6 literal to its eight 16-bit groups, handling `::` and a
 * trailing embedded dotted-quad. Returns undefined when malformed.
 */
function expandV6(ip: string): number[] | undefined {
  let s = ip;
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (s.includes('.')) {
    // embedded dotted-quad → two hex groups, so one parse path below
    const colon = s.lastIndexOf(':');
    const quad = s.slice(colon + 1).split('.').map(Number);
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
    const [q0, q1, q2, q3] = [quad[0] ?? 0, quad[1] ?? 0, quad[2] ?? 0, quad[3] ?? 0];
    s = `${s.slice(0, colon + 1)}${((q0 << 8) | q1).toString(16)}:${((q2 << 8) | q3).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const split = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const head = split(halves[0] ?? '');
  const tail = halves.length === 2 ? split(halves[1] ?? '') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return undefined;
  const groups: number[] = [];
  for (const g of [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    groups.push(parseInt(g, 16));
  }
  return groups;
}

export function isPrivateAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) return isPrivateV4(addr);
  if (kind === 6) {
    const g = expandV6(addr.toLowerCase());
    if (g === undefined) return true; // fail closed
    const [g0, g5, g6, g7] = [g[0] ?? 0, g[5] ?? 0, g[6] ?? 0, g[7] ?? 0];
    const zeroPrefix = g.slice(0, 5).every((n) => n === 0);
    if (zeroPrefix && (g5 === 0xffff || g5 === 0)) {
      // v4-mapped ::ffff:0:0/96 (every notation) and v4-compatible ::/96 —
      // including ::1 and :: themselves, which embed 0.0.0.x and stay blocked
      return isPrivateV4(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
    }
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return true; // not an IP at all — fail closed
}

async function assertPublicHost(url: URL, allow: ReadonlySet<string>): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (allow.has(host.toLowerCase())) return;
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw new ModelFacingError(`fetch blocked: ${host} is a private/loopback address`);
    }
    return;
  }
  const answers = await lookup(host, { all: true }).catch(() => undefined);
  if (answers === undefined || answers.length === 0) {
    throw new ModelFacingError(`fetch failed: could not resolve host ${host}`);
  }
  for (const a of answers) {
    if (isPrivateAddress(a.address)) {
      throw new ModelFacingError(`fetch blocked: ${host} resolves to private address ${a.address}`);
    }
  }
}

export function makeFetchTool(opts?: FetchOpts): ToolSpec<FetchIn> {
  const allow = new Set((opts?.allowHosts ?? []).map((h) => h.toLowerCase()));

  return defineTool<FetchIn>({
    name: 'fetch',
    description:
      'Fetch a public http(s) URL (GET) and return the body with its HTTP status. Follows up to ' +
      '5 redirects; all request headers are dropped when a redirect crosses origins. Private and ' +
      'loopback addresses are blocked.',
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The http(s) URL to fetch' },
        headers: { type: 'object', description: 'Optional request headers' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    concurrencySafe: () => true,
    permissionKey: (input) => ({ tool: 'fetch', action: 'network', target: input.url }),
    run: async (input, ctx) => {
      let current: URL;
      try {
        current = new URL(input.url);
      } catch {
        throw new ModelFacingError(`invalid url: ${JSON.stringify(input.url)}`);
      }
      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new ModelFacingError(`unsupported protocol ${current.protocol} — only http and https`);
      }

      const headers = new Headers(input.headers ?? {});
      const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicHost(current, allow);
        const res = await fetch(current, { method: 'GET', headers, redirect: 'manual', signal }).catch((err: unknown) => {
          throw new ModelFacingError(`fetch failed for ${current.href}: ${err instanceof Error ? err.message : String(err)}`);
        });

        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location !== null) {
          await res.body?.cancel();
          const next = new URL(location, current);
          if (next.origin !== current.origin) {
            // custom auth schemes (X-Api-Key etc.) leak like standard ones —
            // drop every caller header at the origin boundary
            for (const name of [...headers.keys()]) headers.delete(name);
          }
          current = next;
          continue;
        }

        const text = await res.text();
        const body = text.length > MAX_TEXT_CHARS
          ? `${text.slice(0, MAX_TEXT_CHARS)}\n[truncated: ${text.length - MAX_TEXT_CHARS} more chars]`
          : text;
        return { content: `HTTP ${res.status} ${current.href}\n\n${body}` };
      }
      throw new ModelFacingError(`too many redirects (>${MAX_REDIRECTS}) starting from ${input.url}`);
    },
  });
}
