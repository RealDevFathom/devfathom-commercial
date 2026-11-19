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
import {
  lotSaleUnitOptions,
  saleUnitOptions,
  type PackLevelNode,
  type SaleUnitOption,
} from './counter-pricing';
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

/** DEV-957 phase 2: an offline row with what selling it needs (sale units, rounding). */
export type OfflineSaleRow = OfflineCatalogueRow & {
  presentationId: string;
  /** The pack level the lot was received against. */
  packLevelId: string;
  dosageForm: string | null;
  /**
   * DEV-957 phase 2: the lot's MED-08 rounding increment, as the server prices it. Null on
   * a price list signed before offline selling, which is then good for price check only.
   */
  roundingIncrementMinor: number | null;
  /** The pack, strip and unit this lot can be sold in, largest first. */
  saleUnits: SaleUnitOption[];
  /** The batch printed on the receipt; null when the price list does not carry it. */
  batchNumber: string | null;
};

type CatalogPresentation = {
  id: string;
  presentation: string;
  dosageForm?: string | null;
  packLevels: Array<{ id: string } & Partial<PackLevelNode>>;
};
type CatalogMedicine = {
  id: string;
  productName: string;
  presentations: CatalogPresentation[];
};
type PricedLot = {
  id: string;
  packLevelId: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  receivedExpiresAt: string | null;
  roundingIncrementMinor?: number;
  batchNumber?: string | null;
};

function packNodes(presentation: CatalogPresentation): PackLevelNode[] {
  return (Array.isArray(presentation.packLevels) ? presentation.packLevels : []).flatMap((node) =>
    isRecord(node) &&
    typeof node.id === 'string' &&
    typeof node.level === 'string' &&
    (node.parentPackLevelId === null || typeof node.parentPackLevelId === 'string') &&
    Number.isSafeInteger(node.unitsPerParent)
      ? [
          {
            id: node.id,
            level: node.level,
            parentPackLevelId: node.parentPackLevelId ?? null,
            unitsPerParent: node.unitsPerParent as number,
          },
        ]
      : []
  );
}

/**
 * The units this lot can be sold in, from the signed pack setup: the same derivation the
 * online counter offers (`saleUnitOptions` from the lot's own pack level), else the lot's
 * own frozen conversion (sealed pack and loose unit). The server checks each one against
 * the stored pack setup at replay (assertSaleUnitConversion).
 */
function offlineSaleUnits(presentation: CatalogPresentation, lot: PricedLot): SaleUnitOption[] {
  const nodes = packNodes(presentation);
  try {
    return saleUnitOptions({
      packLevels: nodes,
      rootPackLevelId: lot.packLevelId,
      unitsPerPack: lot.unitsPerPack,
    });
  } catch {
    const own = nodes.find((node) => node.id === lot.packLevelId);
    try {
      return lotSaleUnitOptions({
        packLevelId: lot.packLevelId,
        levelLabel: own?.level ?? 'PACK',
        unitsPerPack: lot.unitsPerPack,
      });
    } catch {
      return [];
    }
  }
}

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
  return offlineSaleRows(state, nowMs).map((row) => ({
    inventoryLotId: row.inventoryLotId,
    stockLocationId: row.stockLocationId,
    medicineId: row.medicineId,
    medicineName: row.medicineName,
    presentation: row.presentation,
    unitsPerPack: row.unitsPerPack,
    packPriceMinor: row.packPriceMinor,
    unitsLeft: row.unitsLeft,
    expiresAt: row.expiresAt,
  }));
}

/**
 * DEV-957 phase 2: the same rows as `offlineCatalogueRows`, with the sale units, the
 * rounding increment and the identifiers an offline sale line needs.
 */
export function offlineSaleRows(state: CounterRuntimeState, nowMs: number): OfflineSaleRow[] {
  const catalog = snapshotOf(state, 'CATALOG');
  const prices = snapshotOf(state, 'PRICES');
  if (!usable(catalog, nowMs) || !usable(prices, nowMs)) return [];
  const recalled = new Set<string>();
  for (const snapshot of state.catalog?.snapshots ?? [])
    for (const lotId of snapshot.envelope.safetyLease.recalledBatchIds) recalled.add(lotId);
  for (const event of state.queue?.safetyLeaseEvents ?? [])
    for (const lotId of event.recalledBatchIds ?? []) recalled.add(lotId);

  const byPackLevel = new Map<
    string,
    { medicine: CatalogMedicine; presentation: CatalogPresentation }
  >();
  for (const medicine of catalogMedicines(catalog!.payload))
    for (const presentation of medicine.presentations)
      for (const packLevel of Array.isArray(presentation.packLevels) ? presentation.packLevels : [])
        if (isRecord(packLevel) && typeof packLevel.id === 'string')
          byPackLevel.set(packLevel.id, { medicine, presentation });
  const lots = new Map(pricedLots(prices!.payload).map((lot) => [lot.id, lot]));

  const rows: OfflineSaleRow[] = [];
  for (const quota of (state.queue?.quotas ?? []) as CounterQuota[]) {
    const unitsLeft = quota.quotaUnits - quota.consumedUnits;
    if (!Number.isSafeInteger(unitsLeft) || unitsLeft <= 0) continue;
    const lot = lots.get(quota.inventoryLotId);
    if (!lot || recalled.has(lot.id)) continue;
    const expiresAtMs = lot.receivedExpiresAt ? Date.parse(lot.receivedExpiresAt) : NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) continue;
    const listed = byPackLevel.get(lot.packLevelId);
    if (!listed) continue;
    const rounding = lot.roundingIncrementMinor;
    rows.push({
      inventoryLotId: lot.id,
      stockLocationId: quota.stockLocationId,
      medicineId: listed.medicine.id,
      medicineName: listed.medicine.productName,
      presentationId: listed.presentation.id,
      presentation: listed.presentation.presentation,
      packLevelId: lot.packLevelId,
      dosageForm:
        typeof listed.presentation.dosageForm === 'string' ? listed.presentation.dosageForm : null,
      unitsPerPack: lot.unitsPerPack,
      packPriceMinor: lot.printedMrpMinor,
      roundingIncrementMinor:
        Number.isSafeInteger(rounding) && (rounding as number) > 0 ? (rounding as number) : null,
      saleUnits: offlineSaleUnits(listed.presentation, lot),
      batchNumber: typeof lot.batchNumber === 'string' && lot.batchNumber ? lot.batchNumber : null,
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
export function searchOfflineCatalogue<Row extends OfflineCatalogueRow>(
  rows: readonly Row[],
  query: string,
  limit = 20
): Row[] {
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
