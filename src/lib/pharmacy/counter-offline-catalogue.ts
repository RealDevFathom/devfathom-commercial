/**
 * DEV-957 phase 1: what an enrolled counter can look up with no connection.
 *
 * Built ONLY from snapshots the runtime installed after verifying their
 * signatures (CATALOG, PRICES, LOT_BALANCES) and from the counter's own quota
 * ledger. A medicine appears only when every one of these holds:
 *
 *  - it is in the signed CATALOG, which the server limits to saleable medicines
 *    that are not prescription-only, controlled, restricted, high-alert or
 *    look-alike sound-alike (pharmacy-offline.ts snapshot operation);
 *  - one of its lots is in the signed PRICES, is not recalled under any signed
 *    safety lease the counter holds, and has a recorded expiry still ahead;
 *  - this counter holds quota units of that lot that it has not used yet, so
 *    nothing it shows could take stock another counter or the shop owns.
 *
 * The price shown is the lot's printed MRP for one sealed pack, which the server
 * charges exactly (`priceFromLot`): no client arithmetic on money happens here.
 * Pure and client-safe.
 */
import type { CounterQuota } from './counter-command-queue';
import type { CounterRuntimeState, StoredCounterSnapshot } from './counter-offline-runtime';
import type { PharmacyOfflineSnapshotKind } from './offline-action-matrix';

/** The kinds a cash sale needs (OFF-02 matrix, CASH_OTC_SALE). */
export const OFFLINE_SALE_SNAPSHOT_KINDS: readonly PharmacyOfflineSnapshotKind[] = [
  'CATALOG',
  'PRICES',
  'TAX',
  'RULES',
  'LOT_BALANCES',
];

export type OfflineCatalogueRow = {
  inventoryLotId: string;
  stockLocationId: string;
  medicineId: string;
  medicineName: string;
  presentation: string;
  unitsPerPack: number;
  packPriceMinor: number;
  /** Units this counter may still sell of this lot. */
  unitsLeft: number;
  expiresAt: string;
};

type CatalogMedicine = {
  id: string;
  productName: string;
  presentations: Array<{ id: string; presentation: string; packLevels: Array<{ id: string }> }>;
};
type PricedLot = {
  id: string;
  packLevelId: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  receivedExpiresAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function catalogMedicines(payload: unknown): CatalogMedicine[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (row): row is CatalogMedicine =>
      isRecord(row) &&
      typeof row.id === 'string' &&
      typeof row.productName === 'string' &&
      Array.isArray(row.presentations)
  );
}

function pricedLots(payload: unknown): PricedLot[] {
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (row): row is PricedLot =>
      isRecord(row) &&
      typeof row.id === 'string' &&
      typeof row.packLevelId === 'string' &&
      Number.isSafeInteger(row.unitsPerPack) &&
      (row.unitsPerPack as number) > 0 &&
      Number.isSafeInteger(row.printedMrpMinor) &&
      (row.printedMrpMinor as number) > 0
  );
}

function usable(snapshot: StoredCounterSnapshot | undefined, nowMs: number): boolean {
  return Boolean(
    snapshot &&
      snapshot.verified &&
      Date.parse(snapshot.envelope.issuedAt) <= nowMs &&
      Date.parse(snapshot.envelope.expiresAt) > nowMs
  );
}

function snapshotOf(state: CounterRuntimeState, kind: PharmacyOfflineSnapshotKind) {
  return state.catalog?.snapshots.find((snapshot) => snapshot.envelope.kind === kind);
}

/** Every lot this counter could offer offline right now, by medicine name. */
export function offlineCatalogueRows(
  state: CounterRuntimeState,
  nowMs: number
): OfflineCatalogueRow[] {
  const catalog = snapshotOf(state, 'CATALOG');
  const prices = snapshotOf(state, 'PRICES');
  if (!usable(catalog, nowMs) || !usable(prices, nowMs)) return [];
  const recalled = new Set<string>();
  for (const snapshot of state.catalog?.snapshots ?? [])
    for (const lotId of snapshot.envelope.safetyLease.recalledBatchIds) recalled.add(lotId);
  for (const event of state.queue?.safetyLeaseEvents ?? [])
    for (const lotId of event.recalledBatchIds ?? []) recalled.add(lotId);

  const byPackLevel = new Map<string, { medicine: CatalogMedicine; presentation: string }>();
  for (const medicine of catalogMedicines(catalog!.payload))
    for (const presentation of medicine.presentations)
      for (const packLevel of Array.isArray(presentation.packLevels) ? presentation.packLevels : [])
        if (isRecord(packLevel) && typeof packLevel.id === 'string')
          byPackLevel.set(packLevel.id, { medicine, presentation: presentation.presentation });
  const lots = new Map(pricedLots(prices!.payload).map((lot) => [lot.id, lot]));

  const rows: OfflineCatalogueRow[] = [];
  for (const quota of (state.queue?.quotas ?? []) as CounterQuota[]) {
    const unitsLeft = quota.quotaUnits - quota.consumedUnits;
    if (!Number.isSafeInteger(unitsLeft) || unitsLeft <= 0) continue;
    const lot = lots.get(quota.inventoryLotId);
    if (!lot || recalled.has(lot.id)) continue;
    const expiresAtMs = lot.receivedExpiresAt ? Date.parse(lot.receivedExpiresAt) : NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    const listed = byPackLevel.get(lot.packLevelId);
    if (!listed) continue;
    rows.push({
      inventoryLotId: lot.id,
      stockLocationId: quota.stockLocationId,
      medicineId: listed.medicine.id,
      medicineName: listed.medicine.productName,
      presentation: listed.presentation,
      unitsPerPack: lot.unitsPerPack,
      packPriceMinor: lot.printedMrpMinor,
      unitsLeft,
      expiresAt: lot.receivedExpiresAt!,
    });
  }
  return rows.sort(
    (a, b) =>
      a.medicineName.localeCompare(b.medicineName) ||
      a.expiresAt.localeCompare(b.expiresAt) ||
      a.inventoryLotId.localeCompare(b.inventoryLotId)
  );
}

/** A name search over the offline rows: two characters at least, at most `limit` hits. */
export function searchOfflineCatalogue(
  rows: readonly OfflineCatalogueRow[],
  query: string,
  limit = 20
): OfflineCatalogueRow[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < 2) return [];
  return rows
    .filter((row) => row.medicineName.toLocaleLowerCase().includes(needle))
    .slice(0, limit);
}

export type CounterOfflineReadiness = {
  /** Every snapshot a cash sale needs is installed, verified and in its window. */
  snapshotsReady: boolean;
  /** When the oldest of those snapshots was signed, or null when there are none. */
  priceListIssuedAt: string | null;
  /** When the first of them stops being valid, or null when there are none. */
  offlineUntil: string | null;
  receiptNumbersLeft: number;
  /** Medicines (lots) this counter may still sell offline. */
  itemsAvailable: number;
  /** Prepared: receipt numbers and stock quota are both held. */
  prepared: boolean;
};

export function counterOfflineReadiness(
  state: CounterRuntimeState,
  nowMs: number
): CounterOfflineReadiness {
  const needed = OFFLINE_SALE_SNAPSHOT_KINDS.map((kind) => snapshotOf(state, kind));
  const held = needed.filter((snapshot): snapshot is StoredCounterSnapshot => Boolean(snapshot));
  const issued = held.map((snapshot) => snapshot.envelope.issuedAt).sort();
  const expiries = held.map((snapshot) => snapshot.envelope.expiresAt).sort();
  const receiptNumbersLeft = (state.queue?.leases ?? []).reduce(
    (total, lease) => total + Math.max(0, lease.blockEnd - lease.nextNumber + 1),
    0
  );
  const itemsAvailable = offlineCatalogueRows(state, nowMs).length;
  return {
    snapshotsReady: needed.every((snapshot) => usable(snapshot, nowMs)),
    priceListIssuedAt: issued[0] ?? null,
    offlineUntil: expiries[0] ?? null,
    receiptNumbersLeft,
    itemsAvailable,
    prepared: receiptNumbersLeft > 0 && itemsAvailable > 0,
  };
}
