import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-957 phase 1: what "Prepare this counter for offline" proposes to grant one
 * enrolled counter. Read only. The grant itself is the counter route's
 * manager-only quota operation, and the database guard
 * (`guard_pharmacy_device_lot_quota`) still refuses any grant that would let the
 * quotas of all counters exceed what the bucket holds.
 *
 * A bucket is proposed only when the online counter could sell it AND it is safe
 * offline: an AVAILABLE balance at an active selling location, an ACTIVE (not
 * recalled or quarantined) batch with a recorded expiry still ahead, and a
 * medicine that is saleable and neither prescription-only, controlled,
 * restricted, high-alert nor look-alike sound-alike. Serialised lots (GS1 packs
 * received with a serial) are left out: their serial is claimed at an online sale.
 *
 * Default per bucket (owner question 4): the smaller of half the units on hand
 * and 20 units, never more than the units still free after supplier claims,
 * customer restock reservations and every counter's outstanding quota.
 */
export const OFFLINE_PREPARATION_LOT_LIMIT = 100;
export const OFFLINE_PREPARATION_DEFAULT_CAP = 20;

export type OfflinePreparationLot = {
  inventoryLotId: string;
  stockLocationId: string;
  locationName: string;
  medicineId: string;
  medicineName: string;
  batchNumber: string | null;
  expiresAt: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  onHandUnits: number;
  /** Units no counter holds yet: on hand less claims, reservations and open quotas. */
  freeUnits: number;
  /** Units this counter still holds from an earlier grant of this bucket. */
  heldUnits: number;
  /** The default grant; 0 when this counter already holds units of the bucket. */
  suggestedUnits: number;
};

type Row = {
  inventoryLotId: string;
  stockLocationId: string;
  locationName: string;
  medicineId: string;
  medicineName: string;
  batchNumber: string | null;
  expiresAt: Date;
  unitsPerPack: number;
  printedMrpMinor: number;
  onHandUnits: number;
  freeUnits: unknown;
  heldUnits: unknown;
};

/** The default grant for one bucket, in whole canonical units. */
export function defaultOfflineQuota(input: {
  onHandUnits: number;
  freeUnits: number;
  heldUnits: number;
}): number {
  if (input.heldUnits > 0) return 0;
  return Math.max(
    0,
    Math.min(Math.floor(input.onHandUnits / 2), OFFLINE_PREPARATION_DEFAULT_CAP, input.freeUnits)
  );
}

export async function offlinePreparationPlan(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string },
  input: { deviceId: string; now: Date }
): Promise<OfflinePreparationLot[]> {
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`
    SELECT balance."inventoryLotId", balance."stockLocationId", location.name AS "locationName",
           medicine.id AS "medicineId", medicine."productName" AS "medicineName",
           batch."batchNumber", batch."expiresAt", lot."unitsPerPack", lot."printedMrpMinor",
           balance."onHandUnits",
           balance."onHandUnits"
             - COALESCE((SELECT SUM(claim."reservedUnits") FROM pharmacy_supplier_claims claim
                 WHERE claim."organizationId" = balance."organizationId"
                   AND claim."branchId" = balance."branchId"
                   AND claim."inventoryLotId" = balance."inventoryLotId"
                   AND claim.status = 'RESERVED'), 0)
             - COALESCE((SELECT SUM(reservation."reservedUnits")
                 FROM pharmacy_restock_reservations reservation
                 WHERE reservation."organizationId" = balance."organizationId"
                   AND reservation."branchId" = balance."branchId"
                   AND reservation."inventoryLotId" = balance."inventoryLotId"
                   AND reservation."stockLocationId" = balance."stockLocationId"
                   AND reservation.status = 'RESERVED'), 0)
             - COALESCE((SELECT SUM(quota."quotaUnits" - quota."consumedUnits")
                 FROM pharmacy_device_lot_quotas quota
                 WHERE quota."organizationId" = balance."organizationId"
                   AND quota."inventoryLotId" = balance."inventoryLotId"
                   AND quota."stockLocationId" = balance."stockLocationId"
                   AND quota."releasedAt" IS NULL), 0) AS "freeUnits",
           COALESCE((SELECT SUM(quota."quotaUnits" - quota."consumedUnits")
                 FROM pharmacy_device_lot_quotas quota
                 WHERE quota."organizationId" = balance."organizationId"
                   AND quota."deviceId" = ${input.deviceId}
                   AND quota."inventoryLotId" = balance."inventoryLotId"
                   AND quota."stockLocationId" = balance."stockLocationId"
                   AND quota."releasedAt" IS NULL), 0) AS "heldUnits"
    FROM pharmacy_stock_balances balance
    JOIN pharmacy_inventory_lots lot
      ON lot.id = balance."inventoryLotId" AND lot."organizationId" = balance."organizationId"
    JOIN pharmacy_manufacturing_batches batch
      ON batch.id = lot."manufacturingBatchId" AND batch."organizationId" = lot."organizationId"
    JOIN pharmacy_medicines medicine
      ON medicine.id = batch."medicineId" AND medicine."organizationId" = batch."organizationId"
    JOIN pharmacy_stock_locations location
      ON location.id = balance."stockLocationId"
     AND location."organizationId" = balance."organizationId"
    WHERE balance."organizationId" = ${scope.organizationId}
      AND balance."branchId" = ${scope.branchId}
      AND balance.disposition = 'AVAILABLE'
      AND balance."onHandUnits" > 0
      AND batch.state = 'ACTIVE'
      AND batch."expiresAt" IS NOT NULL
      AND batch."expiresAt" > ${input.now}
      AND location.active
      AND location.kind NOT IN ('QUARANTINE', 'TRANSIT', 'RETURNS')
      AND medicine.saleable
      AND NOT medicine.rx AND NOT medicine.controlled AND NOT medicine.restricted
      AND NOT medicine."highAlert" AND NOT medicine.lasa
      AND NOT EXISTS (
        SELECT 1 FROM pharmacy_goods_receipt_lines line
        WHERE line."organizationId" = lot."organizationId"
          AND line."inventoryLotId" = lot.id
          AND line."serialKey" IS NOT NULL)
    ORDER BY batch."expiresAt" ASC, medicine."productName" ASC,
             balance."inventoryLotId" ASC, balance."stockLocationId" ASC
    LIMIT ${OFFLINE_PREPARATION_LOT_LIMIT}`);
  return rows.map((row) => {
    const freeUnits = Math.max(0, Number(row.freeUnits));
    const heldUnits = Math.max(0, Number(row.heldUnits));
    return {
      inventoryLotId: row.inventoryLotId,
      stockLocationId: row.stockLocationId,
      locationName: row.locationName,
      medicineId: row.medicineId,
      medicineName: row.medicineName,
      batchNumber: row.batchNumber,
      expiresAt: row.expiresAt.toISOString(),
      unitsPerPack: row.unitsPerPack,
      printedMrpMinor: row.printedMrpMinor,
      onHandUnits: row.onHandUnits,
      freeUnits,
      heldUnits,
      suggestedUnits: defaultOfflineQuota({ onHandUnits: row.onHandUnits, freeUnits, heldUnits }),
    };
  });
}
