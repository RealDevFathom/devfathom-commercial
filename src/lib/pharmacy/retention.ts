import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type PharmacyRecordClass = 'PRESCRIPTION' | 'CONTROLLED_REGISTER' | 'FISCAL' | 'AUDIT';

export class PharmacyLegalHoldError extends Error {
  constructor(readonly holdKeys: readonly string[]) {
    super(`Deletion refused: record is protected by legal hold (${holdKeys.join(', ')}).`);
    this.name = 'PharmacyLegalHoldError';
  }
}

export async function activeLegalHoldKeys(
  db: ScopedDb,
  recordClass: PharmacyRecordClass,
  recordId: string
): Promise<string[]> {
  const events = await db.pharmacyLegalHoldEvent.findMany({
    where: { recordClass, recordId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { holdKey: true, kind: true },
  });
  const state = new Map<string, boolean>();
  for (const event of events) state.set(event.holdKey, event.kind === 'PLACED');
  return [...state]
    .filter(([, active]) => active)
    .map(([key]) => key)
    .sort();
}

export async function assertPharmacyRecordDeletable(
  db: ScopedDb,
  recordClass: PharmacyRecordClass,
  recordId: string
): Promise<void> {
  const holds = await activeLegalHoldKeys(db, recordClass, recordId);
  if (holds.length > 0) throw new PharmacyLegalHoldError(holds);
}

/**
 * Spec §3 — the statutory floor for a controlled-drug register entry: at least three
 * years. The provincial texts and federal SRO 1214(I)/96 all set three years; a branch
 * profile may keep records longer (`retentionControlledRegisterYears`) but never less.
 */
export const CONTROLLED_REGISTER_MIN_RETENTION_YEARS = 3;

export class PharmacyRetentionError extends Error {
  constructor(readonly retainedUntil: Date) {
    super(
      `Deletion refused: the controlled register entry is within its retention window (until ${retainedUntil.toISOString()}).`
    );
    this.name = 'PharmacyRetentionError';
  }
}

/**
 * The date a controlled register entry may first be deleted: `years` (at least three)
 * from the later of the entry's own date and the last entry in its register (§7e).
 */
export function controlledRegisterRetainedUntil(
  entryAt: Date,
  lastEntryAt: Date,
  years: number = CONTROLLED_REGISTER_MIN_RETENTION_YEARS
): Date {
  const span = Math.max(years, CONTROLLED_REGISTER_MIN_RETENTION_YEARS);
  const anchor = Math.max(entryAt.getTime(), lastEntryAt.getTime());
  const until = new Date(anchor);
  until.setUTCFullYear(until.getUTCFullYear() + span);
  return until;
}

/**
 * Refuse to delete a controlled register entry while it is on legal hold or inside its
 * retention window. The database enforces the window too (a BEFORE DELETE trigger); this
 * is the application-facing guard, so a purge worker can report a date rather than a 23514.
 */
export async function assertControlledRegisterDeletable(
  db: ScopedDb,
  recordId: string,
  now: Date,
  years: number = CONTROLLED_REGISTER_MIN_RETENTION_YEARS
): Promise<void> {
  await assertPharmacyRecordDeletable(db, 'CONTROLLED_REGISTER', recordId);
  const entry = await db.pharmacyControlledRegisterEntry.findFirst({
    where: { id: recordId },
    select: { organizationId: true, branchId: true, createdAt: true },
  });
  if (!entry) return;
  const last = await db.pharmacyControlledRegisterEntry.aggregate({
    where: { organizationId: entry.organizationId, branchId: entry.branchId },
    _max: { createdAt: true },
  });
  const retainedUntil = controlledRegisterRetainedUntil(
    entry.createdAt,
    last._max.createdAt ?? entry.createdAt,
    years
  );
  if (now < retainedUntil) throw new PharmacyRetentionError(retainedUntil);
}
