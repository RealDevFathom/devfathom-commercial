import 'server-only';

/**
 * PH-MIG / MIG-04 — cutover, sequence ownership and the rollback window.
 *
 * MIG-04's acceptance is "rollback loses no cutover-window transactions", and
 * the way this module earns it is by never having a statement that could lose
 * one. Ownership of receipt numbering is NOT a flag on the branch that cutover
 * sets and rollback unsets. It is the latest row of an append-only event log:
 *
 *   (no events)            → LEGACY owns numbering
 *   … + CUTOVER            → DEVFATHOM owns numbering
 *   … + CUTOVER, ROLLBACK  → LEGACY owns numbering again
 *
 * Rolling back therefore ADDS a row. It deletes no sale, rewinds no receipt
 * sequence, and reverses no stock movement — the receipts issued while DevFathom
 * owned the sequence keep the numbers they were issued with, which is what makes
 * the rollback safe to perform and the audit trail continuous. A database
 * trigger makes the log append-only, so this is structural rather than a promise
 * about how callers behave.
 *
 * The rollback WINDOW is a deadline recorded on the cutover itself, so "can we
 * still roll back?" is answered by the event, not by a policy constant that may
 * have changed since.
 */
import { createHash } from 'node:crypto';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import type { LedgerScope } from '../stock-ledger';

export class PharmacyCutoverError extends Error {
  constructor(
    readonly reason:
      | 'NOT_FOUND'
      | 'CROSS_BRANCH_REFERENCE'
      | 'ALREADY_CUT_OVER'
      | 'NOT_CUT_OVER'
      | 'ROLLBACK_WINDOW_EXPIRED'
      | 'ALREADY_ROLLED_BACK'
      | 'INVALID_WINDOW'
      | 'ARCHIVE_REQUIRED'
  ) {
    super(reason);
    this.name = 'PharmacyCutoverError';
  }
}

export type SequenceOwner = 'LEGACY' | 'DEVFATHOM';

/** SHA-256 of the archive bytes, lowercase hex — the archive's identity. */
export function hashArchiveBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Register the incumbent's archived data as an immutable reference.
 *
 * The bytes are not stored, exactly as MIG-01 treats a profiled source: the hash
 * proves the archive handed over is the archive referenced, and the storage
 * location says where to find it. Registering the same bytes twice returns the
 * existing reference rather than minting a second identity for one archive.
 */
export async function recordLegacyArchive(
  db: ScopedDb,
  scope: LedgerScope,
  input: { label: string; storageLocation: string; bytes: Uint8Array | string }
) {
  const contentHash = hashArchiveBytes(input.bytes);
  const byteSize = BigInt(
    typeof input.bytes === 'string' ? Buffer.byteLength(input.bytes) : input.bytes.byteLength
  );

  const existing = await db.pharmacyLegacyArchive.findFirst({
    where: { organizationId: scope.organizationId, contentHash },
  });
  if (existing) return existing;

  return db.pharmacyLegacyArchive.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      label: input.label,
      contentHash,
      storageLocation: input.storageLocation,
      byteSize,
      archivedByActorId: scope.actorId,
    },
  });
}

/** The branch's cutover/rollback log, oldest first. */
export async function cutoverHistory(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  return db.pharmacyCutoverEvent.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId },
    orderBy: [{ effectiveAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
}

/**
 * Who owns receipt numbering right now.
 *
 * The latest event decides, and no event means the incumbent still owns it. This
 * is a fold over the log rather than a stored flag, so there is no state to get
 * out of step with the history.
 */
export async function receiptSequenceOwner(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
): Promise<SequenceOwner> {
  const events = await cutoverHistory(db, scope);
  return events.length === 0 ? 'LEGACY' : events[events.length - 1].sequenceOwner;
}

/**
 * Take ownership of receipt numbering for this branch.
 *
 * The archive reference is required, not optional: MIG-04 pairs cutover with an
 * immutable legacy archive, and a cutover with no archive to fall back on is the
 * one case a rollback could not survive.
 */
export async function cutOver(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    effectiveAt: Date;
    rollbackDeadline: Date;
    legacyArchiveId: string;
    reason: string;
  }
) {
  if (input.rollbackDeadline <= input.effectiveAt) {
    throw new PharmacyCutoverError('INVALID_WINDOW');
  }
  if ((await receiptSequenceOwner(db, scope)) === 'DEVFATHOM') {
    throw new PharmacyCutoverError('ALREADY_CUT_OVER');
  }

  const archive = await db.pharmacyLegacyArchive.findFirst({
    where: {
      id: input.legacyArchiveId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
  });
  if (!archive) throw new PharmacyCutoverError('ARCHIVE_REQUIRED');

  return db.pharmacyCutoverEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: 'CUTOVER',
      sequenceOwner: 'DEVFATHOM',
      effectiveAt: input.effectiveAt,
      rollbackDeadline: input.rollbackDeadline,
      legacyArchiveId: archive.id,
      actorId: scope.actorId,
      reason: input.reason,
    },
  });
}

/** The cutover currently in force, or null while the incumbent still owns it. */
export async function activeCutover(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>
) {
  const events = await cutoverHistory(db, scope);
  const latest = events[events.length - 1];
  return latest && latest.kind === 'CUTOVER' ? latest : null;
}

/**
 * Return receipt numbering to the incumbent, within the rollback window.
 *
 * This is an append, and nothing else. The sales, receipts and stock movements
 * recorded while DevFathom owned the sequence are untouched and stay queryable —
 * `cutoverWindowTransactionCount` is the read that proves it.
 */
export async function rollBack(
  db: ScopedDb,
  scope: LedgerScope,
  input: { at: Date; reason: string }
) {
  const cutover = await activeCutover(db, scope);
  if (!cutover) throw new PharmacyCutoverError('NOT_CUT_OVER');
  if (cutover.rollbackDeadline !== null && input.at > cutover.rollbackDeadline) {
    throw new PharmacyCutoverError('ROLLBACK_WINDOW_EXPIRED');
  }

  return db.pharmacyCutoverEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: 'ROLLBACK',
      sequenceOwner: 'LEGACY',
      effectiveAt: input.at,
      cutoverEventId: cutover.id,
      legacyArchiveId: cutover.legacyArchiveId,
      actorId: scope.actorId,
      reason: input.reason,
    },
  });
}

/**
 * How many sales this branch recorded while DevFathom owned the sequence.
 *
 * The count is taken over the window a cutover opened — from its `effectiveAt`
 * to the rollback that closed it, or to now if none has. Reading the same number
 * before and after a rollback is the direct evidence for MIG-04's acceptance.
 */
export async function cutoverWindowTransactionCount(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'branchId'>,
  cutoverEventId: string
): Promise<number> {
  const cutover = await db.pharmacyCutoverEvent.findFirst({
    where: {
      id: cutoverEventId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: 'CUTOVER',
    },
  });
  if (!cutover) throw new PharmacyCutoverError('NOT_FOUND');

  const rollback = await db.pharmacyCutoverEvent.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      kind: 'ROLLBACK',
      cutoverEventId: cutover.id,
    },
  });

  return db.pharmacySale.count({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      createdAt: {
        gte: cutover.effectiveAt,
        ...(rollback ? { lte: rollback.effectiveAt } : {}),
      },
    },
  });
}
