// Transport-level provider failure. Carries exactly what retry, credential
// rotation, and failover need to decide their next move — status, an
// optional server-stated wait, and the provider's own retry hint.

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly shouldRetry: boolean | undefined;

  constructor(
    status: number,
    message: string,
    opts?: { retryAfterMs?: number; shouldRetry?: boolean; cause?: unknown },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderHttpError';
    this.status = status;
    this.retryAfterMs = opts?.retryAfterMs;
    this.shouldRetry = opts?.shouldRetry;
  }
}
