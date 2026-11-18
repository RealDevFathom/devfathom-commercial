/**
 * DEV-90 — the server side of shelf and price stickers.
 *
 * Resolves what a sticker may say for each lot of one branch, from one of three
 * sources: a posted goods receipt (one sticker per accepted pack by default), a
 * list of medicines, or a counter search. The price is the lot's printed MRP —
 * the number `priceFromLot` charges for a sealed pack — and the strip price is
 * the same MED-08 derivation the counter quotes, so the shelf never shows a
 * price the till will not charge. A lot that cannot be sold (expired, recalled,
 * quarantined, nothing on hand) is returned with its reason and must not be
 * printed.
 *
 * READ-ONLY.
 */

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { renderStrength, searchCounterCatalog, type CounterScope } from './counter';
import { resolveCounterSaleUnits, type PackLevelNode } from './counter-pricing';
import { blockReasonFor, type BlockReason, type StockDisposition } from './inventory';
import { mrpRoundingIncrementForLot, priceFromLot } from './medicine';
import { shelfLabelCode } from './shelf-label-code';
import type { ShelfLabelRow } from './shelf-label';
import { normalizeExpiryBoundary } from './stock-ledger';

export class ShelfLabelSourceError extends Error {
  constructor(readonly reason: 'NOT_FOUND' | 'RECEIPT_NOT_POSTED') {
    super(reason);
  }
}

export type ShelfLabelSource =
  | { kind: 'RECEIPT'; goodsReceiptId: string }
  | { kind: 'MEDICINES'; medicineIds: string[] }
  | { kind: 'SEARCH'; query: string };

export type ShelfLabelSheet = { title: string; rows: ShelfLabelRow[] };

const UNAVAILABLE: Record<BlockReason, string> = {
  EXPIRED: 'This batch has expired.',
  RECALLED: 'This batch is recalled.',
  QUARANTINED: 'This batch is quarantined.',
  DAMAGED: 'This stock is recorded as damaged.',
  DESTROYED: 'This stock is recorded as destroyed.',
  IN_TRANSIT: 'This stock is in transit.',
  RETURNED_TO_SUPPLIER: 'This stock is held for return to the supplier.',
  UNRECEIVED: 'This lot has not been received yet.',
  UNAUTHORIZED: 'This batch cannot be sold.',
  EMPTY: 'No sellable stock of this batch is on hand.',
};

/** Pharmacy expiry is a Pakistan calendar date; `expiresAt` is its exclusive end. */
export function printedExpiryLabel(expiresAt: Date, precision: 'DAY' | 'MONTH'): string;
export function printedExpiryLabel(
  expiresAt: Date | null,
  precision: 'DAY' | 'MONTH'
): string | null;
export function printedExpiryLabel(
  expiresAt: Date | null,
  precision: 'DAY' | 'MONTH'
): string | null {
  // DEV-853: an expiry that was never recorded has no printed label.
  if (expiresAt === null) return null;
  const boundary = normalizeExpiryBoundary(expiresAt);
  const lastValidPkt = new Date(boundary.getTime() - 1 + 5 * 60 * 60 * 1000).toISOString();
  return precision === 'MONTH' ? lastValidPkt.slice(0, 7) : lastValidPkt.slice(0, 10);
}

/**
 * The counter's price for one strip of a lot, or null when the pack hierarchy
 * has no strip level (or no longer agrees with the received lot, in which case
 * the counter offers no strip either).
 */
export function stripPriceForLot(input: {
  packLevels: readonly (PackLevelNode & {
    effectiveFrom?: Date;
    effectiveTo?: Date | null;
    versionGroupId?: string;
  })[];
  packLevelId: string;
  unitsPerPack: number;
  printedMrpMinor: number;
  roundingIncrementMinor: number;
  at?: Date;
}): number | null {
  try {
    const strip = resolveCounterSaleUnits({
      packLevels: input.packLevels,
      lotPackLevelId: input.packLevelId,
      lotPackLevelLabel:
        input.packLevels.find((level) => level.id === input.packLevelId)?.level ?? null,
      lotUnitsPerPack: input.unitsPerPack,
      dosageForm: null,
      at: input.at ?? new Date(),
    }).saleUnits.findLast((option) => option.kind === 'STRIP');
    if (!strip) return null;
    return priceFromLot({
      printedMrpMinor: input.printedMrpMinor,
      canonicalUnitsInPack: input.unitsPerPack,
      canonicalUnitsPerSaleUnit: strip.canonicalUnitsPerSaleUnit,
      roundingIncrementMinor: input.roundingIncrementMinor,
    }).unitPriceMinor;
  } catch {
    return null;
  }
}

const MAX_LOTS = 200;

async function rowsForLots(
  db: ScopedDb,
  scope: CounterScope,
  lotIds: readonly string[],
  defaultCounts: ReadonlyMap<string, number>,
  at: Date
): Promise<ShelfLabelRow[]> {
  if (lotIds.length === 0) return [];
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      id: { in: [...lotIds] },
    },
    select: {
      id: true,
      shelfLabelNumber: true,
      packLevelId: true,
      unitsPerPack: true,
      printedMrpMinor: true,
      receivedAt: true,
      packLevel: { select: { presentationId: true } },
      batch: {
        select: {
          batchNumber: true,
          expiresAt: true,
          expiryPrecision: true,
          state: true,
          medicine: {
            select: { productName: true, strengths: { select: { value: true, unit: true } } },
          },
        },
      },
    },
  });
  const presentationIds = [...new Set(lots.map((lot) => lot.packLevel.presentationId))];
  const [packLevels, mrps, balances] = await Promise.all([
    db.packLevel.findMany({
      where: { organizationId: scope.organizationId, presentationId: { in: presentationIds } },
      select: {
        id: true,
        level: true,
        parentPackLevelId: true,
        unitsPerParent: true,
        presentationId: true,
        effectiveFrom: true,
        effectiveTo: true,
        versionGroupId: true,
      },
    }),
    db.medicinePackMrp.findMany({
      where: {
        organizationId: scope.organizationId,
        // DEV-853: a lot with no recorded batch has no batch-specific rule.
        OR: lots.flatMap((lot) =>
          lot.batch.batchNumber === null
            ? []
            : [{ packLevelId: lot.packLevelId, batchReference: lot.batch.batchNumber }]
        ),
      },
      select: { packLevelId: true, batchReference: true, roundingIncrementMinor: true },
    }),
    db.pharmacyStockBalance.findMany({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        inventoryLotId: { in: lots.map((lot) => lot.id) },
      },
      select: {
        inventoryLotId: true,
        stockLocationId: true,
        disposition: true,
        onHandUnits: true,
      },
    }),
  ]);

  const lotById = new Map(lots.map((lot) => [lot.id, lot]));
  const rows: ShelfLabelRow[] = [];
  for (const lotId of lotIds) {
    const lot = lotById.get(lotId);
    if (!lot) continue;
    let sellable = false;
    let blocked: BlockReason | null = null;
    for (const balance of balances) {
      if (balance.inventoryLotId !== lot.id) continue;
      const reason = blockReasonFor(
        {
          inventoryLotId: lot.id,
          stockLocationId: balance.stockLocationId,
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          batchState: lot.batch.state,
          disposition: balance.disposition as StockDisposition,
          expiresAt: lot.batch.expiresAt,
          receivedAt: lot.receivedAt,
          availableUnits: balance.onHandUnits,
        },
        { ...scope, at }
      );
      if (reason === null) sellable = true;
      else if (reason !== 'EMPTY' && blocked === null) blocked = reason;
    }
    const levels = packLevels.filter(
      (level) => level.presentationId === lot.packLevel.presentationId
    );
    rows.push({
      inventoryLotId: lot.id,
      code: shelfLabelCode(lot.shelfLabelNumber),
      name: lot.batch.medicine.productName,
      strength: renderStrength(lot.batch.medicine.strengths),
      packMrpMinor: lot.printedMrpMinor,
      stripMrpMinor: stripPriceForLot({
        at,
        packLevels: levels,
        packLevelId: lot.packLevelId,
        unitsPerPack: lot.unitsPerPack,
        printedMrpMinor: lot.printedMrpMinor,
        roundingIncrementMinor: mrpRoundingIncrementForLot(mrps, {
          packLevelId: lot.packLevelId,
          batchNumber: lot.batch.batchNumber,
        }),
      }),
      expiry: printedExpiryLabel(lot.batch.expiresAt, lot.batch.expiryPrecision),
      batchNumber: lot.batch.batchNumber,
      defaultCount: defaultCounts.get(lot.id) ?? 1,
      unavailableReason: sellable ? null : UNAVAILABLE[blocked ?? 'EMPTY'],
    });
  }
  return rows;
}

async function receiptSheet(
  db: ScopedDb,
  scope: CounterScope,
  goodsReceiptId: string,
  at: Date
): Promise<ShelfLabelSheet> {
  const receipt = await db.pharmacyGoodsReceipt.findFirst({
    where: { id: goodsReceiptId, organizationId: scope.organizationId, branchId: scope.branchId },
    select: {
      reference: true,
      status: true,
      lines: {
        orderBy: { lineNumber: 'asc' },
        select: {
          inventoryLotId: true,
          acceptedCanonicalUnits: true,
          canonicalUnitsPerPack: true,
        },
      },
    },
  });
  if (!receipt) throw new ShelfLabelSourceError('NOT_FOUND');
  // Only goods that reached the ledger have a lot, a price and a shelf.
  if (receipt.status !== 'POSTED') throw new ShelfLabelSourceError('RECEIPT_NOT_POSTED');
  const counts = new Map<string, number>();
  for (const line of receipt.lines) {
    if (!line.inventoryLotId || line.acceptedCanonicalUnits <= 0) continue;
    // One sticker per accepted pack; loose units alone still get one sticker.
    const packs = Math.max(
      1,
      Math.floor(line.acceptedCanonicalUnits / Math.max(1, line.canonicalUnitsPerPack))
    );
    counts.set(line.inventoryLotId, (counts.get(line.inventoryLotId) ?? 0) + packs);
  }
  return {
    title: `Goods receipt ${receipt.reference}`,
    rows: await rowsForLots(db, scope, [...counts.keys()], counts, at),
  };
}

async function medicinesSheet(
  db: ScopedDb,
  scope: CounterScope,
  medicineIds: readonly string[],
  title: string,
  at: Date
): Promise<ShelfLabelSheet> {
  if (medicineIds.length === 0) return { title, rows: [] };
  // Lots this branch still holds stock of, in shelf (FEFO) order per medicine.
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      batch: { medicineId: { in: [...medicineIds] } },
      balances: { some: { onHandUnits: { gt: 0 } } },
    },
    select: { id: true, batch: { select: { medicineId: true } } },
    orderBy: [{ batch: { expiresAt: 'asc' } }, { receivedAt: 'asc' }, { id: 'asc' }],
    take: MAX_LOTS,
  });
  const order = new Map(medicineIds.map((id, index) => [id, index]));
  const lotIds = lots
    .toSorted(
      (left, right) =>
        (order.get(left.batch.medicineId) ?? 0) - (order.get(right.batch.medicineId) ?? 0)
    )
    .map((lot) => lot.id);
  return { title, rows: await rowsForLots(db, scope, lotIds, new Map(), at) };
}

export async function readShelfLabelSheet(
  db: ScopedDb,
  scope: CounterScope,
  source: ShelfLabelSource,
  at: Date = new Date()
): Promise<ShelfLabelSheet> {
  if (source.kind === 'RECEIPT') return receiptSheet(db, scope, source.goodsReceiptId, at);
  if (source.kind === 'MEDICINES') {
    const medicines = await db.medicine.findMany({
      where: {
        organizationId: scope.organizationId,
        saleable: true,
        id: { in: source.medicineIds },
      },
      select: { id: true },
    });
    const known = new Set(medicines.map((medicine) => medicine.id));
    return medicinesSheet(
      db,
      scope,
      [...new Set(source.medicineIds)].filter((id) => known.has(id)),
      'Selected medicines',
      at
    );
  }
  const { rows } = await searchCounterCatalog(db, scope, { query: source.query, at });
  return medicinesSheet(
    db,
    scope,
    rows.map((row) => row.medicineId),
    `Search “${source.query.trim()}”`,
    at
  );
}
