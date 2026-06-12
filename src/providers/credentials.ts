// Credential pool (DESIGN §5.4 recovery ladder, step 2): auth material with
// health states. 401/403 kills a credential, 429 cools it for the server-
// stated window, success restores it. process.env access is permitted here
// and in src/config/ only (constitution A5).

export type CredentialState = 'valid' | 'cooling' | 'dead';

export interface Credential {
  readonly id: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface CredentialStatus {
  readonly id: string;
  readonly state: CredentialState;
  readonly coolUntil: number;
}

export const DEFAULT_COOL_MS = 60_000;

interface Entry {
  readonly cred: Credential;
  readonly state: CredentialState;
  readonly coolUntil: number;
}

export class CredentialPool {
  #entries: readonly Entry[];
  #now: () => number;
  #coolMs: number;

  constructor(creds: readonly Credential[], opts?: { now?: () => number; coolMs?: number }) {
    this.#entries = creds.map((cred) => ({ cred, state: 'valid', coolUntil: 0 }));
    this.#now = opts?.now ?? Date.now;
    this.#coolMs = opts?.coolMs ?? DEFAULT_COOL_MS;
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Idempotent read: the first usable credential, or undefined. */
  current(): Credential | undefined {
    const now = this.#now();
    const usable = this.#entries.find(
      (e) => e.state === 'valid' || (e.state === 'cooling' && now >= e.coolUntil),
    );
    return usable?.cred;
  }

  reportFailure(id: string, status: number, retryAfterMs?: number): void {
    if (status === 401 || status === 403) {
      this.#update(id, () => ({ state: 'dead', coolUntil: 0 }));
    } else if (status === 429) {
      const coolUntil = this.#now() + (retryAfterMs ?? this.#coolMs);
      this.#update(id, (e) => (e.state === 'dead' ? e : { state: 'cooling', coolUntil }));
    }
    // other statuses are not the credential's fault
  }

  reportSuccess(id: string): void {
    this.#update(id, (e) => (e.state === 'dead' ? e : { state: 'valid', coolUntil: 0 }));
  }

  statuses(): readonly CredentialStatus[] {
    return this.#entries.map((e) => ({ id: e.cred.id, state: e.state, coolUntil: e.coolUntil }));
  }

  #update(id: string, fn: (e: Entry) => Pick<Entry, 'state' | 'coolUntil'> | Entry): void {
    this.#entries = this.#entries.map((e) => (e.cred.id === id ? { ...e, ...fn(e) } : e));
  }
}

export type AuthKind = 'anthropic' | 'openai';

export function credentialFromEnv(id: string, envVar: string, kind: AuthKind): Credential | null {
  const value = process.env[envVar];
  if (value === undefined || value === '') return null;
  const headers = kind === 'anthropic' ? { 'x-api-key': value } : { authorization: `Bearer ${value}` };
  return { id, headers };
}
