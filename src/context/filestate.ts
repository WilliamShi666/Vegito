// File freshness ledger (DESIGN §6): which files this session has seen, and at
// what mtime. write refuses to overwrite unseen files; edit refuses stale ones.
// P3 carries the minimal contract; P5 grows staleness-driven context refresh.

export class FileState {
  #seen = new Map<string, number>();

  noteSeen(path: string, mtimeMs: number): void {
    this.#seen.set(path, mtimeMs);
  }

  seenAt(path: string): number | undefined {
    return this.#seen.get(path);
  }
}
