import { join } from 'node:path';

import { appendJsonl, scanJsonl } from '../lib/jsonl.ts';
import { editFingerprint } from './candidate.ts';
import type { CandidateBundle, CandidateEvalReport, RejectedEditRecord } from './types.ts';

export const EDIT_LEDGER = join('.evolve', 'edit-ledger.jsonl');
export const REJECTED_EDITS = join('.evolve', 'rejected-edits.jsonl');

export interface EditLedgerRecord {
  readonly schema: 1;
  readonly candidateId: string;
  readonly editId: string;
  readonly harnessId: string;
  readonly harnessDomain: string;
  readonly target: string;
  readonly operation: string;
  readonly proposerKind: string;
  readonly verdict: 'accepted' | 'partial';
  readonly fingerprint: string;
  readonly reasons: readonly string[];
}

function reasonsForEdit(report: CandidateEvalReport, editId: string): readonly string[] {
  if (report.decision.rejectedEditIds.includes(editId)) {
    return report.decision.reasons.filter((reason) => /ablation|rejected edit|guard|safety/i.test(reason));
  }
  return report.decision.reasons.length === 0 ? ['passed promotion gate'] : report.decision.reasons;
}

export function toEditLedgerRecords(
  candidate: CandidateBundle,
  report: CandidateEvalReport,
  verdict: 'accepted' | 'partial',
): readonly EditLedgerRecord[] {
  return candidate.atomicEdits
    .filter((edit) => report.decision.acceptedEditIds.includes(edit.editId))
    .map((edit): EditLedgerRecord => ({
      schema: 1,
      candidateId: candidate.candidateId,
      editId: edit.editId,
      harnessId: candidate.harnessId,
      harnessDomain: candidate.harnessDomain,
      target: edit.target,
      operation: edit.operation,
      proposerKind: candidate.proposer.kind,
      verdict,
      fingerprint: editFingerprint(candidate, edit),
      reasons: reasonsForEdit(report, edit.editId),
    }));
}

export function toRejectedEditRecords(candidate: CandidateBundle, report: CandidateEvalReport): readonly RejectedEditRecord[] {
  const rejectedIds =
    report.decision.rejectedEditIds.length > 0
      ? report.decision.rejectedEditIds
      : report.decision.verdict === 'rejected'
        ? candidate.atomicEdits.map((edit) => edit.editId)
        : [];
  return candidate.atomicEdits
    .filter((edit) => rejectedIds.includes(edit.editId))
    .map((edit): RejectedEditRecord => ({
      schema: 1,
      candidateId: candidate.candidateId,
      editId: edit.editId,
      harnessId: candidate.harnessId,
      harnessDomain: candidate.harnessDomain,
      fingerprint: editFingerprint(candidate, edit),
      reasons: reasonsForEdit(report, edit.editId),
    }));
}

export async function appendEditLedgerRecords(root: string, records: readonly EditLedgerRecord[]): Promise<void> {
  for (const record of records) await appendJsonl(join(root, EDIT_LEDGER), record);
}

export async function appendRejectedEditRecords(root: string, records: readonly RejectedEditRecord[]): Promise<void> {
  for (const record of records) await appendJsonl(join(root, REJECTED_EDITS), record);
}

function isRejectedEditRecord(value: unknown): value is RejectedEditRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['schema'] === 1 &&
    typeof (value as Record<string, unknown>)['fingerprint'] === 'string'
  );
}

export async function loadRejectedFingerprints(root: string): Promise<ReadonlySet<string>> {
  try {
    const scan = await scanJsonl(join(root, REJECTED_EDITS));
    return new Set(scan.records.filter(isRejectedEditRecord).map((record) => record.fingerprint));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
}
