import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

export type PharmacyRecordClass = 'PRESCRIPTION' | 'CONTROLLED_REGISTER' | 'FISCAL' | 'AUDIT';

export type PharmacyRetentionScope = {
  organizationId: string;
  /** Branchless prescriptions and audit records require tenant-wide scope. */
  branchId?: string;
};

export class PharmacyRetentionError extends Error {
  constructor(
    readonly recordClass: PharmacyRecordClass,
    readonly recordId: string,
    readonly retentionUntil: Date | null,
    reason: string
  ) {
    super(`Deletion refused: ${reason}`);
    this.name = 'PharmacyRetentionError';
  }
}

export type PharmacyRetentionStatus = {
  retentionUntil: Date | null;
  checkedAt: Date;
  blockedReason: string | null;
  eligible: boolean;
};

const RECORD_CLASSES: readonly PharmacyRecordClass[] = [
  'PRESCRIPTION',
  'CONTROLLED_REGISTER',
  'FISCAL',
  'AUDIT',
];

function validateScope(scope: PharmacyRetentionScope) {
  if (!scope.organizationId?.trim() || (scope.branchId !== undefined && !scope.branchId.trim())) {
    throw new Error(
      'Retention requires an explicit organization and a nonempty branch if supplied.'
    );
  }
}

/** SQL owns policy selection, holds and the clock; callers cannot supply a permissive deadline. */
export async function pharmacyRetentionStatus(
  db: ScopedDb,
  scope: PharmacyRetentionScope,
  recordClass: PharmacyRecordClass,
  recordId: string
): Promise<PharmacyRetentionStatus> {
  validateScope(scope);
  if (!RECORD_CLASSES.includes(recordClass) || !recordId.trim()) {
    throw new Error('Invalid pharmacy retention record.');
  }
  const rows = await db.$queryRaw<Omit<PharmacyRetentionStatus, 'eligible'>[]>`
    SELECT * FROM pharmacy_record_retention_status(
      ${scope.organizationId}::text, ${recordClass}::text,
      ${recordId}::text, ${scope.branchId ?? null}::text
    )
  `;
  const status = rows[0];
  if (
    rows.length !== 1 ||
    !(status?.checkedAt instanceof Date) ||
    !Number.isFinite(status.checkedAt.getTime()) ||
    (status.blockedReason !== null && typeof status.blockedReason !== 'string') ||
    (status.retentionUntil !== null &&
      (!(status.retentionUntil instanceof Date) ||
        !Number.isFinite(status.retentionUntil.getTime()))) ||
    (status.retentionUntil === null && !status.blockedReason)
  ) {
    throw new PharmacyRetentionError(
      recordClass,
      recordId,
      null,
      'retention policy could not be verified.'
    );
  }
  return {
    ...status,
    eligible:
      status.blockedReason === null &&
      status.retentionUntil !== null &&
      status.retentionUntil <= status.checkedAt,
  };
}

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
  recordId: string,
  scope: PharmacyRetentionScope
): Promise<void> {
  const status = await pharmacyRetentionStatus(db, scope, recordClass, recordId);
  if (!status.eligible) {
    throw new PharmacyRetentionError(
      recordClass,
      recordId,
      status.retentionUntil,
      status.blockedReason ??
        `record must be retained until ${status.retentionUntil!.toISOString()}.`
    );
  }
}

export type PharmacyRetentionOwner = {
  recordClass: PharmacyRecordClass;
  /** Return a stable, bounded page; owners may maintain their own scan cursor. */
  candidates: (
    tx: ScopedDb,
    scope: PharmacyRetentionScope,
    limit: number
  ) => Promise<readonly string[]>;
  /** Delete the entire aggregate using this transaction; throw on failure, never perform external I/O. */
  deleteAggregate: (tx: ScopedDb, scope: PharmacyRetentionScope, recordId: string) => Promise<void>;
};

/**
 * Run inside a tenant transaction. The shared SQL lock covers scanning, current
 * rule/hold revalidation and owner deletion. Any owner failure rolls back the batch.
 * Existing append-only guards remain authoritative even after retention expires.
 */
export async function runPharmacyRetentionPurge(
  db: ScopedDb,
  scope: PharmacyRetentionScope,
  owners: readonly PharmacyRetentionOwner[],
  limit = 100
): Promise<{ examined: number; deleted: number; blocked: number }> {
  validateScope(scope);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('Retention purge limit must be an integer from 1 to 500.');
  }
  if (
    owners.some((owner) => !RECORD_CLASSES.includes(owner.recordClass)) ||
    new Set(owners.map((owner) => owner.recordClass)).size !== owners.length
  ) {
    throw new Error('Retention purge requires one owner per record class.');
  }
  return db.$transaction(async (transaction) => {
    const tx = transaction as ScopedDb;
    // ScopedDb reuses outer transactions; a savepoint also protects callers that catch owner errors.
    const savepoint = `pharmacy_retention_${crypto.randomUUID().replaceAll('-', '')}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
    try {
      // A void result column cannot be decoded by the pg adapter; select a constant instead.
      await tx.$queryRaw`SELECT 1 AS locked FROM pharmacy_lock_retention()`;
      const result = { examined: 0, deleted: 0, blocked: 0 };
      for (const owner of owners) {
        const remaining = limit - result.examined;
        if (!remaining) break;
        const candidates = await owner.candidates(tx, scope, remaining);
        if (
          !Array.isArray(candidates) ||
          candidates.length > remaining ||
          candidates.some((id) => typeof id !== 'string' || !id.trim()) ||
          new Set(candidates).size !== candidates.length
        ) {
          throw new Error('Retention owner returned an invalid or unbounded candidate page.');
        }
        for (const recordId of candidates) {
          result.examined++;
          const status = await pharmacyRetentionStatus(tx, scope, owner.recordClass, recordId);
          if (!status.eligible) {
            result.blocked++;
            continue;
          }
          await owner.deleteAggregate(tx, scope, recordId);
          result.deleted++;
        }
      }
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  });
}
