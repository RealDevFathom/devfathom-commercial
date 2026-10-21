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
