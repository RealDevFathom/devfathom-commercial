import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { allocateBranchReceiptNumbers } from './branch-receipt-sequence';

/**
 * PH-OFF / OFF-01 and §8A invariant 16 — pre-allocated receipt-number leases.
 *
 * "Reconnect never renumbers an issued receipt" is not a property of the replay
 * code; it is a property of WHERE the numbers came from. A counter that is about
 * to lose connectivity RESERVES a block of numbers up front, out of the SAME
 * branch-wide sequence (`pharmacy_branch_receipt_sequences`, DEV-637) that the
 * connected settlement path of every counter draws from. Two consequences follow,
 * and they are the whole point:
 *
 *  - while the counter is offline, the numbers it prints are already its own, so
 *    replay records them rather than assigning new ones;
 *  - the connected path can keep issuing at the same branch the whole time,
 *    because it draws from a sequence whose high-water mark has already moved
 *    past the reserved block.
 *
 * The reservation and the block insert share one transaction, and the database
 * guard re-checks both facts (the block is below the sequence's high-water mark,
 * and it overlaps no other lease of the branch) so a caller that skips this
 * module still cannot hand two counters the same number.
 *
 * A lease is never rewound and never deleted: `nextNumber` only advances, and
 * `blockEnd + 1` is the exhausted marker.
 */

export class PharmacyReceiptLeaseError extends Error {
  constructor(
    readonly reason: 'INVALID_SIZE' | 'DEVICE_NOT_USABLE' | 'LEASE_EXHAUSTED' | 'NOT_FOUND'
  ) {
    super(reason);
    this.name = 'PharmacyReceiptLeaseError';
  }
}

export type ReceiptLeaseScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
};

/** A conservative ceiling: a counter that reserves more than a day of numbers
 * would strand them if it never comes back, and the gap is permanent. */
export const MAX_RECEIPT_LEASE_SIZE = 1_000;

export type ReceiptLease = {
  id: string;
  deviceId: string;
  blockStart: number;
  blockEnd: number;
  nextNumber: number;
};

/** Numbers still unissued across a set of leases. Pure, so the counter can show
 * the operator how much runway it has without a round trip. */
export function remainingLeasedNumbers(leases: readonly ReceiptLease[]): number {
  return leases.reduce((total, lease) => total + (lease.blockEnd - lease.nextNumber + 1), 0);
}

/** The next number a counter would print: the lowest open one, so blocks are
 * consumed in the order they were reserved. */
export function nextLeasedNumber(leases: readonly ReceiptLease[]): number | null {
  let best: number | null = null;
  for (const lease of leases) {
    if (lease.nextNumber > lease.blockEnd) continue;
    if (best === null || lease.nextNumber < best) best = lease.nextNumber;
  }
  return best;
}

/**
 * Reserve `size` consecutive receipt numbers for one counter.
 *
 * The branch sequence row is advanced by `size` under its row lock, so a concurrent
 * online settlement or a second reservation (from any counter of the branch) cannot
 * observe the same high-water mark. The returned block lies strictly below the new
 * high-water mark, which is exactly the condition the database guard enforces.
 */
export async function reserveReceiptNumberBlock(
  db: ScopedDb,
  scope: ReceiptLeaseScope,
  input: { deviceId: string; size: number }
): Promise<ReceiptLease> {
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_RECEIPT_LEASE_SIZE) {
    throw new PharmacyReceiptLeaseError('INVALID_SIZE');
  }

  const device = await db.pharmacyRegisteredDevice.findFirst({
    where: {
      id: input.deviceId,
      organizationId: scope.organizationId,
      branchId: scope.branchId,
    },
    select: { status: true, revokedAt: true },
  });
  if (!device || device.status !== 'ACTIVE' || device.revokedAt !== null) {
    throw new PharmacyReceiptLeaseError('DEVICE_NOT_USABLE');
  }

  // DEV-637: the block is carved out of the BRANCH sequence that online sales also draw
  // from, under its row lock, so a concurrent sale or another counter's reservation can
  // never be handed a number inside this block.
  const blockStart = await allocateBranchReceiptNumbers(db, scope, input.size);
  const blockEnd = blockStart + input.size - 1;

  const lease = await db.pharmacyReceiptNumberLease.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: input.deviceId,
      blockStart,
      blockEnd,
      nextNumber: blockStart,
      issuedToActorId: scope.actorId,
    },
    select: { id: true, deviceId: true, blockStart: true, blockEnd: true, nextNumber: true },
  });
  return lease;
}

/** Every lease of one counter, oldest block first. */
export async function listReceiptLeases(
  db: ScopedDb,
  scope: Pick<ReceiptLeaseScope, 'organizationId' | 'branchId'>,
  deviceId: string
): Promise<ReceiptLease[]> {
  return db.pharmacyReceiptNumberLease.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, deviceId },
    orderBy: { blockStart: 'asc' },
    select: { id: true, deviceId: true, blockStart: true, blockEnd: true, nextNumber: true },
  });
}

/**
 * Issue the next number from this counter's oldest open lease and advance its
 * cursor, under a row lock so two concurrent issues cannot take the same number.
 * Throws when every reserved number has been used — the counter must reconnect
 * rather than invent one.
 */
export async function issueLeasedReceiptNumber(
  db: ScopedDb,
  scope: Pick<ReceiptLeaseScope, 'organizationId' | 'branchId'>,
  deviceId: string
): Promise<{ leaseId: string; receiptNumber: number }> {
  const rows = await db.$queryRaw<Array<{ id: string; nextNumber: number }>>(Prisma.sql`
    SELECT id, "nextNumber"
    FROM pharmacy_receipt_number_leases
    WHERE "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId}
      AND "deviceId" = ${deviceId}
      AND "nextNumber" <= "blockEnd"
    ORDER BY "blockStart" ASC
    LIMIT 1
    FOR UPDATE`);
  const open = rows[0];
  if (!open) throw new PharmacyReceiptLeaseError('LEASE_EXHAUSTED');

  const receiptNumber = open.nextNumber;
  await db.pharmacyReceiptNumberLease.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: open.id } },
    data: { nextNumber: receiptNumber + 1 },
  });
  return { leaseId: open.id, receiptNumber };
}
