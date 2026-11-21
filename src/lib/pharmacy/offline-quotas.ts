import 'server-only';

import { Prisma } from '@/generated/prisma/client';
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
 * That sum is enforced by the database, not here. `guard_pharmacy_device_lot_quota`
 * locks the balance row BEFORE it sums, so two grants racing for the same last
 * unit serialize and the loser is refused; the service below adds the domain
 * error and the branch scoping on top. The guard is the mechanism, this module
 * is the vocabulary — the same division as the stock ledger's non-negative CHECK.
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
 * outage. Refused when the branch does not hold enough units once every other
 * counter's outstanding quota is counted — that refusal is the DB guard's, and
 * it is what makes a concurrent last-unit grant impossible.
 */
export async function grantDeviceLotQuota(
  db: ScopedDb,
  scope: QuotaScope,
  input: QuotaBucket & { deviceId: string; units: number }
) {
  if (!Number.isSafeInteger(input.units) || input.units <= 0) {
    throw new PharmacyQuotaError('INVALID_UNITS');
  }

  // DEV-957: FOR SHARE holds the counter row until this grant commits, so a revoke
  // (which updates that row) waits for the grant and then releases it, and a grant
  // that starts while a revoke is in flight waits, re-reads the row as REVOKED and is
  // refused. Without the lock a grant racing its own counter's revoke left units held
  // by a revoked counter for good.
  const usable = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM pharmacy_registered_devices
    WHERE id = ${input.deviceId} AND "organizationId" = ${scope.organizationId}
      AND "branchId" = ${scope.branchId} AND status = 'ACTIVE' AND "revokedAt" IS NULL
    FOR SHARE`);
  if (!usable[0]) throw new PharmacyQuotaError('DEVICE_NOT_USABLE');

  // Orders, refills and supplier claims lock this same balance before reserving.
  // Read reservations in a fresh statement after any concurrent writer commits.
  const bucket = Prisma.sql`"organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
    AND "inventoryLotId" = ${input.inventoryLotId} AND "stockLocationId" = ${input.stockLocationId}`;
  const balances = await db.$queryRaw<Array<{ onHandUnits: number }>>(Prisma.sql`
    SELECT "onHandUnits" FROM pharmacy_stock_balances WHERE ${bucket} AND disposition = 'AVAILABLE' FOR UPDATE`);
  const [reserved] = await db.$queryRaw<Array<{ units: bigint }>>(Prisma.sql`
    SELECT COALESCE((SELECT SUM("reservedUnits") FROM pharmacy_supplier_claims
             WHERE "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId}
               AND "inventoryLotId" = ${input.inventoryLotId} AND status = 'RESERVED'), 0)
         + COALESCE((SELECT SUM("reservedUnits") FROM pharmacy_restock_reservations
             WHERE ${bucket} AND status = 'RESERVED'), 0)
         + COALESCE((SELECT SUM("quotaUnits" - "consumedUnits") FROM pharmacy_device_lot_quotas
             WHERE ${bucket} AND "releasedAt" IS NULL), 0) AS units`);
  if (balances[0] && Number(reserved?.units ?? 0) + input.units > balances[0].onHandUnits)
    throw new PharmacyQuotaError('QUOTA_EXCEEDS_ON_HAND');

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
