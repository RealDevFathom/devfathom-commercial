/**
 * Near-expiry alerts at 30, 60 and 90 days, plus the supplier-return list.
 *
 * Batch number and expiry already live on PharmacyManufacturingBatch
 * (`batchNumber`, `expiresAt`) and the received copy on PharmacyInventoryLot.
 * This module only classifies those instants. It never moves stock.
 */

const DAY_MS = 86_400_000;

export const NEAR_EXPIRY_ALERT_DAYS = [30, 60, 90] as const;
export type NearExpiryAlertDays = (typeof NEAR_EXPIRY_ALERT_DAYS)[number];

/** The tightest alert whose window still contains this expiry. Null once it has passed or is beyond 90 days. */
export function nearExpiryAlertBand(expiresAt: Date, at: Date): NearExpiryAlertDays | null {
  const remainingMs = expiresAt.getTime() - at.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  for (const days of NEAR_EXPIRY_ALERT_DAYS) {
    if (remainingMs <= days * DAY_MS) return days;
  }
  return null;
}

export function daysUntilExpiry(expiresAt: Date, at: Date): number {
  return Math.ceil((expiresAt.getTime() - at.getTime()) / DAY_MS);
}

export type NearExpiryReturnLot = {
  lotId: string;
  medicineName: string;
  batchNumber: string;
  supplierId: string | null;
  supplierName: string;
  onHandUnits: number;
  unitCostMinor: number;
  expiresAt: Date;
  /** Days before printed expiry when this supplier accepts a return. Null when none is recorded. */
  returnWindowDays: number | null;
};

export type SupplierReturnRow = NearExpiryReturnLot & {
  alertDays: NearExpiryAlertDays;
  daysRemaining: number;
  /** True when today is inside the recorded supplier return window. */
  returnWindowOpen: boolean;
  valueAtRiskMinor: number;
};

/**
 * Near-expiry stock a branch can send back. Lots with no supplier are omitted:
 * a return list that cannot name who takes the goods is not a return list.
 */
export function listSupplierReturnCandidates(
  lots: readonly NearExpiryReturnLot[],
  at: Date
): SupplierReturnRow[] {
  const rows: SupplierReturnRow[] = [];
  for (const lot of lots) {
    const alertDays = nearExpiryAlertBand(lot.expiresAt, at);
    if (alertDays === null || !Number.isSafeInteger(lot.onHandUnits) || lot.onHandUnits <= 0)
      continue;
    if (lot.supplierId === null && lot.supplierName.trim() === '') continue;
    const windowStartsAt =
      lot.returnWindowDays === null
        ? null
        : lot.expiresAt.getTime() - lot.returnWindowDays * DAY_MS;
    rows.push({
      ...lot,
      alertDays,
      daysRemaining: daysUntilExpiry(lot.expiresAt, at),
      returnWindowOpen: windowStartsAt !== null && at.getTime() >= windowStartsAt,
      valueAtRiskMinor: lot.onHandUnits * lot.unitCostMinor,
    });
  }
  return rows.sort(
    (left, right) =>
      left.expiresAt.getTime() - right.expiresAt.getTime() ||
      left.lotId.localeCompare(right.lotId, 'en')
  );
}
