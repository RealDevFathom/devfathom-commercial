/**
 * DEV-92 — counter sale of one GS1-serialized pack.
 *
 * Under SRO 963(I)/2026 r.3A(4) a medicine sold without an outer box carries
 * its 2D code on the primary bottle or tube. Goods-in already records that
 * GTIN + serial on the receipt line that created the lot (one pack per line).
 * A counter scan of the same pack therefore:
 *   1. re-reads the payload on the server (the browser's parse is never trusted),
 *   2. pins the exact lot goods-in created for that serial, or else the branch
 *      lot carrying the printed batch, and
 *   3. claims the serial for the sale line, so a second sale of the same pack
 *      is refused until the first sale is voided.
 *
 * The live claim is unique per organization and GTIN + serial in the database
 * (`pharmacy_sold_pack_serials_live_key`); the pre-check below only turns the
 * common case into a readable refusal before stock is allocated.
 */
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { parseGs1DataMatrix } from './gs1-datamatrix';
import { normalizeMedicineText } from './medicine';

export type SerializedPackScope = {
  organizationId: string;
  branchId: string;
  actorId: string;
};

export type SerializedPackRefusal =
  | 'SERIAL_NOT_READABLE'
  | 'SERIAL_MEDICINE_MISMATCH'
  | 'SERIAL_ALREADY_SOLD'
  | 'SERIAL_LOT_UNAVAILABLE'
  | 'SERIAL_FEFO_APPROVAL_REQUIRED';

export class PharmacySerializedPackError extends Error {
  constructor(readonly reason: SerializedPackRefusal) {
    super(reason);
  }
}

export type ResolvedSerializedPack = {
  gtin: string;
  serialNumber: string;
  serialKey: string;
  /** The lot this physical pack belongs to. A pack that resolves to no lot is refused. */
  inventoryLotId: string;
};

/**
 * Allocation evidence for a pinned lot. Only recorded when the lot is not FEFO's choice, and
 * then only with a verified FEFO-override approval appended (DEV-843).
 */
export const SERIALIZED_PACK_APPROVAL_POLICY = 'gs1-serialized-pack-scan';

export function serializedPackOverrideReason(serialNumber: string) {
  return `Sold the scanned pack, serial ${serialNumber}.`;
}

function uniqueViolation(error: unknown) {
  return (error as { code?: unknown } | null)?.code === 'P2002';
}

export async function resolveSerializedPackForSale(
  db: ScopedDb,
  scope: SerializedPackScope,
  input: { medicineId: string; payload: string },
  at = new Date()
): Promise<ResolvedSerializedPack> {
  const parsed = parseGs1DataMatrix(input.payload, at);
  if (parsed.kind !== 'parsed' || !parsed.fields.serial || parsed.fields.count !== undefined) {
    throw new PharmacySerializedPackError('SERIAL_NOT_READABLE');
  }
  const { gtin, gtin13, batch, serial } = parsed.fields;
  const codes = [gtin, gtin13].filter((code): code is string => Boolean(code));
  const barcode = await db.medicineBarcode.findFirst({
    where: {
      organizationId: scope.organizationId,
      normalizedCode: { in: codes.map((code) => normalizeMedicineText(code)) },
    },
    select: { presentation: { select: { medicineId: true } } },
  });
  if (barcode?.presentation.medicineId !== input.medicineId) {
    throw new PharmacySerializedPackError('SERIAL_MEDICINE_MISMATCH');
  }

  const serialKey = serial.toUpperCase();
  const live = await db.pharmacySoldPackSerial.findFirst({
    where: { organizationId: scope.organizationId, gtin, serialKey, releasedAt: null },
    select: { id: true },
  });
  if (live) throw new PharmacySerializedPackError('SERIAL_ALREADY_SOLD');

  // Goods-in stamps the lot it created onto the receipt line when it posts.
  const received = await db.pharmacyGoodsReceiptLine.findFirst({
    where: {
      organizationId: scope.organizationId,
      gtin,
      serialKey,
      medicineId: input.medicineId,
      inventoryLotId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    select: { branchId: true, inventoryLotId: true },
  });
  if (received?.inventoryLotId && received.branchId === scope.branchId) {
    return { gtin, serialNumber: serial, serialKey, inventoryLotId: received.inventoryLotId };
  }

  // A pack stocked before 2D capture, or moved here from another branch, is
  // matched by the batch printed in its code, to a lot that still has sellable
  // stock (an emptied lot of the same batch must not shadow a stocked one).
  const lot = batch
    ? await db.pharmacyInventoryLot.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          batch: { medicineId: input.medicineId, batchNumber: batch },
          balances: { some: { disposition: 'AVAILABLE', onHandUnits: { gt: 0 } } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
    : null;
  // Never let an unidentified pack fall back to FEFO: that would debit, and
  // record against this serial, a batch the pack does not belong to.
  if (!lot) throw new PharmacySerializedPackError('SERIAL_LOT_UNAVAILABLE');
  return { gtin, serialNumber: serial, serialKey, inventoryLotId: lot.id };
}

/** Claim the pack for the line that sold it. Concurrent claims lose on the live unique index. */
export async function claimSoldPackSerial(
  db: ScopedDb,
  scope: SerializedPackScope,
  pack: ResolvedSerializedPack,
  sale: { saleId: string; saleLineId: string; inventoryLotId: string }
) {
  try {
    return await db.pharmacySoldPackSerial.create({
      data: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        gtin: pack.gtin,
        serialNumber: pack.serialNumber,
        serialKey: pack.serialKey,
        saleId: sale.saleId,
        saleLineId: sale.saleLineId,
        inventoryLotId: sale.inventoryLotId,
        soldByUserId: scope.actorId,
      },
    });
  } catch (error) {
    if (uniqueViolation(error)) throw new PharmacySerializedPackError('SERIAL_ALREADY_SOLD');
    throw error;
  }
}

/**
 * A voided sale never sold its packs, and a pack returned whole to sellable
 * stock is back on the shelf, so their serials may be sold again. Pass a
 * `saleLineId` to release only that line's pack.
 */
export async function releaseSoldPackSerials(
  db: ScopedDb,
  scope: Omit<SerializedPackScope, 'actorId'>,
  saleId: string,
  at = new Date(),
  saleLineId?: string
) {
  return db.pharmacySoldPackSerial.updateMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId,
      ...(saleLineId ? { saleLineId } : {}),
      releasedAt: null,
    },
    data: { releasedAt: at },
  });
}
