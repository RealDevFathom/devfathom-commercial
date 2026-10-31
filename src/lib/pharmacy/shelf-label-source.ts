import 'server-only';

import { TRPCError } from '@trpc/server';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { renderStrengthValue, type CounterScope } from './counter';
import { saleUnitOptions } from './counter-pricing';
import { priceFromLot } from './medicine';
import { currentPackPrice } from './pricing';
import { parseShelfLabelCode, shelfLabelCode } from './shelf-label-code';
import { normalizeExpiryBoundary } from './stock-ledger';
import { MAX_SHELF_LABELS, type ShelfLabelSource } from './shelf-label';

export const SHELF_LABEL_PAGE_SIZE = 100;

export type ShelfLabelFilter = {
  goodsReceiptId?: string;
  query?: string;
  after?: string;
  inventoryLotIds?: string[];
};

/**
 * One label per pack that reached the shelf: paid and bonus packs count,
 * rejected (quarantined) units do not, and a loose remainder gets one label.
 */
export function shelfPacksFor(acceptedCanonicalUnits: number, canonicalUnitsPerPack: number): number {
  if (!Number.isSafeInteger(canonicalUnitsPerPack) || canonicalUnitsPerPack <= 0) return 0;
  if (!Number.isSafeInteger(acceptedCanonicalUnits) || acceptedCanonicalUnits <= 0) return 0;
  return Math.ceil(acceptedCanonicalUnits / canonicalUnitsPerPack);
}

const PKT_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * The printed expiry of a lot, from its stored EXCLUSIVE boundary (midnight
 * Asia/Karachi after the last good day or month, see `expiryInstant`). One
 * millisecond before that boundary, read in PKT, is the printed day or month.
 */
export function printedExpiry(boundary: Date, precision: 'DAY' | 'MONTH'): string {
  const lastGood = new Date(normalizeExpiryBoundary(boundary).getTime() + PKT_OFFSET_MS - 1);
  return lastGood.toISOString().slice(0, precision === 'MONTH' ? 7 : 10);
}

/**
 * Server-owned price and identity: no money, name, expiry or barcode comes
 * from a form. The pack MRP is the lot's own pack price — exactly what the
 * counter charges for this lot (`addSaleLine` prices from `printedMrpMinor`) —
 * and the strip price is derived the same way, so a label never disagrees
 * with the till. A newer pack-price record that differs is reported, not
 * silently printed.
 */
export async function readShelfLabelSources(
  db: ScopedDb,
  scope: CounterScope,
  input: ShelfLabelFilter,
  at = new Date()
): Promise<{ rows: ShelfLabelSource[]; next: string | null }> {
  // Only the tenant and branch: a caller's LedgerScope also carries the actor.
  const branchScope = { organizationId: scope.organizationId, branchId: scope.branchId };
  const counts = new Map<string, number>();
  if (input.goodsReceiptId) {
    const receipt = await db.pharmacyGoodsReceipt.findFirst({
      where: { ...branchScope, id: input.goodsReceiptId, status: 'POSTED' },
      select: {
        lines: {
          where: branchScope,
          select: {
            inventoryLotId: true,
            acceptedCanonicalUnits: true,
            canonicalUnitsPerPack: true,
          },
        },
      },
    });
    if (!receipt) throw new TRPCError({ code: 'NOT_FOUND', message: 'Posted GRN not found in this branch.' });
    for (const line of receipt.lines) {
      if (!line.inventoryLotId) continue;
      counts.set(
        line.inventoryLotId,
        (counts.get(line.inventoryLotId) ?? 0) +
          shelfPacksFor(line.acceptedCanonicalUnits, line.canonicalUnitsPerPack)
      );
    }
  }
  const requested = input.inventoryLotIds ? [...new Set(input.inventoryLotIds)] : undefined;
  if (requested && input.goodsReceiptId && requested.some((id) => !counts.has(id))) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Selected lot is outside this GRN.' });
  }
  const ids = requested ?? (input.goodsReceiptId ? [...counts.keys()] : undefined);
  const query = requested ? undefined : input.query?.trim();
  const labelNumber = query ? parseShelfLabelCode(query) : null;
  const lots = await db.pharmacyInventoryLot.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      receivedAt: { not: null },
      ...(ids ? { id: { in: ids } } : {}),
      ...(input.after && !requested ? { AND: [{ id: { gt: input.after } }] } : {}),
      ...(labelNumber !== null
        ? { shelfLabelNumber: labelNumber }
        : query
          ? {
              OR: [
                { batch: { batchNumber: { contains: query, mode: 'insensitive' } } },
                { batch: { medicine: { productName: { contains: query, mode: 'insensitive' } } } },
                { batch: { medicine: { brandName: { contains: query, mode: 'insensitive' } } } },
                {
                  batch: {
                    medicine: {
                      aliases: { some: { value: { contains: query, mode: 'insensitive' } } },
                    },
                  },
                },
              ],
            }
          : {}),
    },
    include: {
      batch: {
        include: { medicine: { include: { strengths: { orderBy: { createdAt: 'asc' } } } } },
      },
      packLevel: { include: { presentation: { include: { packLevels: true } } } },
    },
    orderBy: { id: 'asc' },
    ...(requested ? {} : { take: SHELF_LABEL_PAGE_SIZE + 1 }),
  });
  if (requested && lots.length !== requested.length) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Selected lot is outside this branch or has not been received.',
    });
  }
  const page = requested ? lots : lots.slice(0, SHELF_LABEL_PAGE_SIZE);

  // Legacy manufacturer/internal registrations can use these numeric strings.
  // Refuse ambiguous labels rather than print a code that scans as another medicine.
  if (page.length) {
    const collision = await db.medicineBarcode.findFirst({
      where: {
        organizationId: scope.organizationId,
        normalizedCode: { in: page.map((lot) => shelfLabelCode(lot.shelfLabelNumber)) },
      },
      select: { id: true },
    });
    if (collision) {
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'A shelf label code is already registered as a medicine barcode. Resolve the registered barcode before printing this lot.',
      });
    }
  }

  const recordCache = new Map<string, Promise<number | null>>();
  const priceRecord = (packLevelId: string) => {
    let current = recordCache.get(packLevelId);
    if (!current) {
      current = Promise.all([
        currentPackPrice(db, scope.organizationId, packLevelId, at, scope.branchId),
        currentPackPrice(db, scope.organizationId, packLevelId, at),
      ]).then(([branch, organization]) => branch?.mrpMinor ?? organization?.mrpMinor ?? null);
      recordCache.set(packLevelId, current);
    }
    return current;
  };

  const rows = await Promise.all(
    page.map(async (lot): Promise<ShelfLabelSource> => {
      const packMrpMinor = lot.printedMrpMinor;
      const recordMrpMinor = await priceRecord(lot.packLevelId);
      let stripMrpMinor: number | null = null;
      try {
        const strip = saleUnitOptions({
          packLevels: lot.packLevel.presentation.packLevels,
          rootPackLevelId: lot.packLevelId,
          unitsPerPack: lot.unitsPerPack,
        }).find((option) => option.kind === 'STRIP');
        // Same derivation as the sale line, so the strip label equals the till.
        stripMrpMinor = strip
          ? priceFromLot({
              printedMrpMinor: packMrpMinor,
              canonicalUnitsInPack: lot.unitsPerPack,
              canonicalUnitsPerSaleUnit: strip.canonicalUnitsPerSaleUnit,
            }).unitPriceMinor
          : null;
      } catch {
        // A pack hierarchy that disagrees with the lot cannot quote a strip.
        stripMrpMinor = null;
      }
      const medicine = lot.batch.medicine;
      const requestedCount = input.goodsReceiptId ? (counts.get(lot.id) ?? 0) : 1;
      return {
        inventoryLotId: lot.id,
        code: shelfLabelCode(lot.shelfLabelNumber),
        name: medicine.productName,
        strength:
          medicine.strengths.map((s) => `${renderStrengthValue(s.value)} ${s.unit}`).join(' + ') ||
          null,
        packMrpMinor,
        stripMrpMinor,
        priceRecordMrpMinor:
          recordMrpMinor !== null && recordMrpMinor !== packMrpMinor ? recordMrpMinor : null,
        expiry: printedExpiry(lot.receivedExpiresAt, lot.receivedExpiryPrecision),
        batchNumber: lot.batch.batchNumber,
        count: Math.min(requestedCount, MAX_SHELF_LABELS),
      };
    })
  );
  return {
    rows,
    next:
      !requested && lots.length > SHELF_LABEL_PAGE_SIZE
        ? lots[SHELF_LABEL_PAGE_SIZE - 1]!.id
        : null,
  };
}
