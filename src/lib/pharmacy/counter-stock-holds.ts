/**
 * DEV-957 phase 2 — units set aside for an offline counter (OFF-03 device lot quotas)
 * on the online stock paths that are not sales.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 *  - ORDINARY removals (an inter-branch transfer leaving, a supplier claim, a write-off of
 *    good stock) treat a counter's open, unsold quota as taken, exactly as online selling
 *    does (`DEVICE_QUOTA_HELD` in stock-ledger.ts). Short of free units they are refused,
 *    and the refusal names the counter holding them, so nobody has to guess why.
 *  - SAFETY removals (a recall, a quarantine, taking expiring or expired stock off sale)
 *    are never refused because a counter holds units. They release the affected quotas
 *    in the same transaction, one audit row per quota, so the counter cannot sell those
 *    units offline: its next signed stock list no longer carries the quota, and a sale it
 *    sends against it is refused at replay (`openDeviceLotQuota` finds none).
 *
 * Every read here runs after the caller has locked the stock it removes. A grant locks
 * the same balance row before it sums (`guard_pharmacy_device_lot_quota`) and a replay
 * consumes its quota while holding the same locks, so the figure read is settled.
 */
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { PharmacyInventoryError } from './inventory';
import { counterSetAsidesInForce } from './offline-cash-selling';

export type CounterHold = { deviceId: string; counterName: string; heldUnits: number };

/** Open, unsold quota units per counter on one lot (one location of it, or all of them). */
export async function counterHoldsOn(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  bucket: { inventoryLotId: string; stockLocationId?: string }
): Promise<CounterHold[]> {
  // Review round 2: a set-aside holds stock only while offline cash selling is in force.
  if (!(await counterSetAsidesInForce(db, scope.organizationId))) return [];
  const rows = await db.$queryRaw<
    Array<{ deviceId: string; counterName: string; heldUnits: number | bigint }>
  >(Prisma.sql`
    SELECT quota."deviceId" AS "deviceId", device."name" AS "counterName",
           SUM(quota."quotaUnits" - quota."consumedUnits")::int AS "heldUnits"
      FROM "pharmacy_device_lot_quotas" quota
      JOIN "pharmacy_registered_devices" device
        ON device."organizationId" = quota."organizationId"
       AND device."branchId" = quota."branchId"
       AND device."id" = quota."deviceId"
     WHERE quota."organizationId" = ${scope.organizationId}
       AND quota."branchId" = ${scope.branchId}
       AND quota."inventoryLotId" = ${bucket.inventoryLotId}
       ${bucket.stockLocationId ? Prisma.sql`AND quota."stockLocationId" = ${bucket.stockLocationId}` : Prisma.empty}
       AND quota."releasedAt" IS NULL
     GROUP BY quota."deviceId", device."name"
    HAVING SUM(quota."quotaUnits" - quota."consumedUnits") > 0
     ORDER BY device."name", quota."deviceId"`);
  return rows.map((row) => ({ ...row, heldUnits: Number(row.heldUnits) }));
}

function counterNames(holds: readonly CounterHold[]): string {
  const names = holds.map((hold) => hold.counterName);
  const listed =
    names.length <= 1
      ? (names[0] ?? '')
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.length === 1 ? 'counter' : 'counters'} ${listed}`;
}

/** The plain sentence a person sees when units they asked for are held for a counter. */
export function heldForCounterMessage(input: {
  holds: readonly CounterHold[];
  freeUnits: number;
  action: string;
}): string {
  const held = input.holds.reduce((total, hold) => total + hold.heldUnits, 0);
  const left = Math.max(0, input.freeUnits - held);
  return (
    `${held} of these units ${held === 1 ? 'is' : 'are'} set aside for offline selling at ` +
    `${counterNames(input.holds)}, so only ${left} can be ${input.action} now. Take fewer, or ` +
    `hand them back by revoking that counter on Settings > Counter computers.`
  );
}

/**
 * An ordinary removal of `units` from stock that has `freeUnits` free before counter
 * holds are counted. Refused with HELD_FOR_COUNTER when the counters' open quotas leave
 * too few. A caller refuses `freeUnits < units` itself first (INSUFFICIENT_STOCK).
 */
export async function assertNotHeldForCounter(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  bucket: { inventoryLotId: string; stockLocationId?: string },
  input: { freeUnits: number; units: number; action: string }
): Promise<void> {
  if (input.freeUnits < input.units) return;
  const holds = await counterHoldsOn(db, scope, bucket);
  const held = holds.reduce((total, hold) => total + hold.heldUnits, 0);
  if (input.freeUnits - held >= input.units) return;
  throw new PharmacyInventoryError(
    'HELD_FOR_COUNTER',
    heldForCounterMessage({ holds, freeUnits: input.freeUnits, action: input.action })
  );
}

export type CounterQuotaSafetyCause = 'RECALL' | 'QUARANTINE' | 'EXPIRY';

export type ReleasedCounterQuota = {
  quotaId: string;
  branchId: string;
  deviceId: string;
  inventoryLotId: string;
  stockLocationId: string;
  releasedUnits: number;
};

/**
 * A safety action took this stock off sale: release every open counter quota on it, in
 * the caller's transaction, with one audit row per quota. Never refuses. `batchIds`
 * covers every lot of those batches in every branch of the organization (a recall is
 * organization-wide); a bucket covers one lot at one location.
 */
export async function releaseCounterQuotasForSafety(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string | null },
  target:
    | { batchIds: readonly string[] }
    | { branchId: string; inventoryLotId: string; stockLocationId: string },
  cause: CounterQuotaSafetyCause,
  now = new Date()
): Promise<ReleasedCounterQuota[]> {
  if ('batchIds' in target && target.batchIds.length === 0) return [];
  const filter =
    'batchIds' in target
      ? Prisma.sql`AND quota."inventoryLotId" IN (
          SELECT lot."id" FROM "pharmacy_inventory_lots" lot
           WHERE lot."organizationId" = ${scope.organizationId}
             AND lot."manufacturingBatchId" IN (${Prisma.join([...target.batchIds])}))`
      : Prisma.sql`AND quota."branchId" = ${target.branchId}
          AND quota."inventoryLotId" = ${target.inventoryLotId}
          AND quota."stockLocationId" = ${target.stockLocationId}`;
  // Row locks in id order, so two safety actions touching the same quotas never
  // lock them in opposite orders.
  const open = await db.$queryRaw<
    Array<{
      id: string;
      branchId: string;
      deviceId: string;
      inventoryLotId: string;
      stockLocationId: string;
      quotaUnits: number;
      consumedUnits: number;
    }>
  >(Prisma.sql`
    SELECT quota."id", quota."branchId", quota."deviceId", quota."inventoryLotId",
           quota."stockLocationId", quota."quotaUnits", quota."consumedUnits"
      FROM "pharmacy_device_lot_quotas" quota
     WHERE quota."organizationId" = ${scope.organizationId}
       AND quota."releasedAt" IS NULL
       ${filter}
     ORDER BY quota."id" COLLATE "C"
       FOR UPDATE`);
  if (!open.length) return [];
  // A release is final and the rows stay, so what a counter was allowed stays auditable.
  await db.pharmacyDeviceLotQuota.updateMany({
    where: {
      organizationId: scope.organizationId,
      id: { in: open.map((quota) => quota.id) },
      releasedAt: null,
    },
    data: { releasedAt: now },
  });
  const released = open.map((quota) => ({
    quotaId: quota.id,
    branchId: quota.branchId,
    deviceId: quota.deviceId,
    inventoryLotId: quota.inventoryLotId,
    stockLocationId: quota.stockLocationId,
    releasedUnits: quota.quotaUnits - quota.consumedUnits,
  }));
  for (const quota of released) {
    await db.auditLog.create({
      data: {
        organizationId: scope.organizationId,
        actorId: scope.actorId,
        actorType: 'USER',
        source: 'TRPC',
        category: 'PHARMACY',
        operation: 'UPDATE',
        action: 'pharmacyOffline.releaseOfflineQuotaForSafety',
        targetType: 'PharmacyDeviceLotQuota',
        targetId: quota.quotaId,
        metadata: {
          branchId: quota.branchId,
          deviceId: quota.deviceId,
          inventoryLotId: quota.inventoryLotId,
          stockLocationId: quota.stockLocationId,
          releasedUnits: quota.releasedUnits,
          cause,
        },
      },
    });
  }
  return released;
}

/**
 * After a safety move took `units` out of one AVAILABLE bucket: when what is left free
 * (on hand less supplier claims and order reservations) no longer covers the counters'
 * open quotas, the move took units a counter held, so those quotas are released. A move
 * that left the counters' units untouched (stock a failed delivery just brought back)
 * releases nothing.
 */
export async function releaseCounterQuotasAffectedBy(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string; actorId: string },
  bucket: { inventoryLotId: string; stockLocationId: string },
  cause: CounterQuotaSafetyCause
): Promise<ReleasedCounterQuota[]> {
  const holds = await counterHoldsOn(db, scope, bucket);
  if (!holds.length) return [];
  const held = holds.reduce((total, hold) => total + hold.heldUnits, 0);
  const rows = await db.$queryRaw<Array<{ freeUnits: number | bigint }>>(Prisma.sql`
    SELECT (balance."onHandUnits" - COALESCE((
      SELECT SUM(claim."reservedUnits") FROM "pharmacy_supplier_claims" claim
       WHERE claim."organizationId" = balance."organizationId"
         AND claim."branchId" = balance."branchId"
         AND claim."inventoryLotId" = balance."inventoryLotId"
         AND claim."status" = 'RESERVED'
    ), 0) - COALESCE((
      SELECT SUM(reservation."reservedUnits") FROM "pharmacy_restock_reservations" reservation
       WHERE reservation."organizationId" = balance."organizationId"
         AND reservation."branchId" = balance."branchId"
         AND reservation."inventoryLotId" = balance."inventoryLotId"
         AND reservation."stockLocationId" = balance."stockLocationId"
         AND reservation."status" = 'RESERVED'
    ), 0))::int AS "freeUnits"
      FROM "pharmacy_stock_balances" balance
     WHERE balance."organizationId" = ${scope.organizationId}
       AND balance."branchId" = ${scope.branchId}
       AND balance."inventoryLotId" = ${bucket.inventoryLotId}
       AND balance."stockLocationId" = ${bucket.stockLocationId}
       AND balance."disposition" = 'AVAILABLE'`);
  const free = Number(rows[0]?.freeUnits ?? 0);
  if (free >= held) return [];
  return releaseCounterQuotasForSafety(
    db,
    scope,
    { branchId: scope.branchId, ...bucket },
    cause
  );
}
