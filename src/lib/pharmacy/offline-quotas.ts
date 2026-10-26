import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * PH-OFF / OFF-03 — multi-counter stock ownership by per-device lot quotas.
 *
 * PRD §6.9 OFF-03: "branch-local coordinator or per-device batch quotas; no
 * independent full-stock snapshots", accepted by "concurrent last-unit sale
 * cannot oversell". This lane takes the quota option, which means one thing
 * above all: the quotas outstanding across EVERY counter for one (lot, location)
 * bucket must never exceed what that bucket actually holds. If they could, each
 * counter would effectively hold its own full-stock snapshot and two of them
 * could sell the same last unit during an outage.
 *
 * That sum is projected by the database onto the AVAILABLE balance row, not
 * calculated here. `guard_pharmacy_device_lot_quota` atomically applies each
 * outstanding-unit delta to that row, so quota grants and stock movements
 * serialize on the same tuple and the operation that would over-allocate stock
 * is refused. The service below adds the domain error and branch scoping on top.
 *
 * A quota is a RESERVATION, not a movement. Selling still posts through the
 * INV-01 ledger with its own FEFO planning and its own non-negative projection;
 * the quota only bounds what one counter may commit to while it cannot see the
 * others.
 */

export class PharmacyQuotaError extends Error {
  constructor(
    readonly reason:
      | 'INVALID_UNITS'
      | 'DEVICE_NOT_USABLE'
      | 'NOT_FOUND'
      | 'ALREADY_RELEASED'
      | 'QUOTA_EXCEEDS_ON_HAND'
      | 'QUOTA_EXHAUSTED'
  ) {
    super(reason);
    this.name = 'PharmacyQuotaError';
  }
}

export type QuotaScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
};

export type QuotaBucket = {
  inventoryLotId: string;
  stockLocationId: string;
};

/** The database guard's own error text, so a domain refusal is not confused with
 * an unrelated failure. Raised with SQLSTATE 55000 by the migration. */
const GUARD_CAPACITY = 'QUOTA_EXCEEDS_ON_HAND';

function isCapacityRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes(GUARD_CAPACITY);
}

/** Units of one bucket that are still owned by some counter and unsold. */
export async function outstandingQuotaUnits(
  db: ScopedDb,
  scope: Pick<QuotaScope, 'organizationId'>,
  bucket: QuotaBucket
): Promise<number> {
  const rows = await db.pharmacyDeviceLotQuota.findMany({
    where: {
      organizationId: scope.organizationId,
      inventoryLotId: bucket.inventoryLotId,
      stockLocationId: bucket.stockLocationId,
      releasedAt: null,
    },
    select: { quotaUnits: true, consumedUnits: true },
  });
  return rows.reduce((total, row) => total + row.quotaUnits - row.consumedUnits, 0);
}

/**
 * Give one counter ownership of `units` of a bucket for the duration of an
 * outage. Refused when the branch does not hold enough unreserved units — that
 * refusal is the DB guard's, and it is what makes a concurrent last-unit grant
 * impossible.
 */
export async function grantDeviceLotQuota(
  db: ScopedDb,
  scope: QuotaScope,
  input: QuotaBucket & { deviceId: string; units: number }
) {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new PharmacyQuotaError('INVALID_UNITS');
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
    throw new PharmacyQuotaError('DEVICE_NOT_USABLE');
  }

  try {
    return await db.pharmacyDeviceLotQuota.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        deviceId: input.deviceId,
        inventoryLotId: input.inventoryLotId,
        stockLocationId: input.stockLocationId,
        quotaUnits: input.units,
        grantedByActorId: scope.actorId,
      },
    });
  } catch (error) {
    if (isCapacityRefusal(error)) throw new PharmacyQuotaError('QUOTA_EXCEEDS_ON_HAND');
    throw error;
  }
}

/** The counter's open quota for a bucket, or null when it owns none. */
export async function openDeviceLotQuota(
  db: ScopedDb,
  scope: Pick<QuotaScope, 'organizationId' | 'branchId'>,
  input: QuotaBucket & { deviceId: string }
) {
  return db.pharmacyDeviceLotQuota.findFirst({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      deviceId: input.deviceId,
      inventoryLotId: input.inventoryLotId,
      stockLocationId: input.stockLocationId,
      releasedAt: null,
    },
  });
}

/**
 * Record that a counter used `units` of its quota. Consumption only ever rises
 * (the update guard refuses a rewind) and can never pass the granted amount (the
 * CHECK refuses it), so a counter cannot quietly regain units it already sold.
 * The row lock makes two concurrent consumptions of the same quota serialize.
 */
export async function consumeDeviceLotQuota(
  db: ScopedDb,
  scope: Pick<QuotaScope, 'organizationId' | 'branchId'>,
  input: QuotaBucket & { deviceId: string; units: number }
) {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new PharmacyQuotaError('INVALID_UNITS');
  }

  const rows = await db.$queryRaw<Array<{ id: string; quotaUnits: number; consumedUnits: number }>>`
    SELECT id, "quotaUnits", "consumedUnits"
    FROM pharmacy_device_lot_quotas
    WHERE "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId}
      AND "deviceId" = ${input.deviceId}
      AND "inventoryLotId" = ${input.inventoryLotId}
      AND "stockLocationId" = ${input.stockLocationId}
      AND "releasedAt" IS NULL
    FOR UPDATE`;
  const quota = rows[0];
  if (!quota) throw new PharmacyQuotaError('NOT_FOUND');
  if (quota.consumedUnits + input.units > quota.quotaUnits) {
    throw new PharmacyQuotaError('QUOTA_EXHAUSTED');
  }

  return db.pharmacyDeviceLotQuota.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: quota.id } },
    data: { consumedUnits: quota.consumedUnits + input.units },
  });
}

/**
 * Hand a counter's remaining units back to the branch once it is online again.
 * The row is kept, not deleted: what a counter was permitted to sell during an
 * outage stays auditable. A release is final.
 */
export async function releaseDeviceLotQuota(
  db: ScopedDb,
  scope: Pick<QuotaScope, 'organizationId' | 'branchId'>,
  quotaId: string,
  now: Date
) {
  const quota = await db.pharmacyDeviceLotQuota.findFirst({
    where: { id: quotaId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: { id: true, releasedAt: true },
  });
  if (!quota) throw new PharmacyQuotaError('NOT_FOUND');
  if (quota.releasedAt !== null) throw new PharmacyQuotaError('ALREADY_RELEASED');

  return db.pharmacyDeviceLotQuota.update({
    where: { organizationId_id: { organizationId: scope.organizationId, id: quota.id } },
    data: { releasedAt: now },
  });
}
