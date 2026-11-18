import { describe, expect, it, vi } from 'vitest';

import { priceFromLot } from './medicine';
import { shelfLabelCode } from './shelf-label-code';
import {
  printedExpiryLabel,
  readShelfLabelSheet,
  ShelfLabelSourceError,
  stripPriceForLot,
} from './shelf-label-source';
import { expiryInstant } from './stock-ledger';

const scope = { organizationId: 'org-a', branchId: 'branch-a' };
const at = new Date('2026-11-15T06:00:00Z');

// Box of 10 strips of 10 tablets: 100 canonical units per sealed pack.
const packLevels = [
  { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1, presentationId: 'p' },
  {
    id: 'strip',
    level: 'STRIP',
    parentPackLevelId: 'box',
    unitsPerParent: 10,
    presentationId: 'p',
  },
  {
    id: 'tab',
    level: 'TABLET',
    parentPackLevelId: 'strip',
    unitsPerParent: 10,
    presentationId: 'p',
  },
];

const medicine = {
  productName: 'Paracetamol',
  strengths: [{ value: '500.000000', unit: 'mg' }],
};
const lots = [
  {
    id: 'lot-a',
    shelfLabelNumber: 41,
    packLevelId: 'box',
    unitsPerPack: 100,
    printedMrpMinor: 12_345,
    receivedAt: new Date('2026-11-01T00:00:00Z'),
    packLevel: { presentationId: 'p' },
    batch: {
      batchNumber: 'B-1',
      expiresAt: expiryInstant(new Date('2027-06-15T00:00:00Z'), 'DAY'),
      expiryPrecision: 'DAY' as const,
      state: 'ACTIVE',
      medicineId: 'med-a',
      medicine,
    },
  },
  {
    id: 'lot-b',
    shelfLabelNumber: 42,
    packLevelId: 'box',
    unitsPerPack: 100,
    printedMrpMinor: 11_000,
    receivedAt: new Date('2026-11-01T00:00:00Z'),
    packLevel: { presentationId: 'p' },
    batch: {
      batchNumber: 'B-2',
      expiresAt: expiryInstant(new Date('2027-03-01T00:00:00Z'), 'MONTH'),
      expiryPrecision: 'MONTH' as const,
      state: 'RECALLED',
      medicineId: 'med-a',
      medicine,
    },
  },
];
const balances = [
  { inventoryLotId: 'lot-a', stockLocationId: 's', disposition: 'AVAILABLE', onHandUnits: 1000 },
  { inventoryLotId: 'lot-b', stockLocationId: 's', disposition: 'AVAILABLE', onHandUnits: 250 },
];

function fakeDb(receipt: unknown = null) {
  return {
    pharmacyGoodsReceipt: { findFirst: vi.fn(async () => receipt) },
    pharmacyInventoryLot: {
      findMany: vi.fn(async ({ where }: { where: { branchId: string; id?: { in: string[] } } }) =>
        where.branchId !== scope.branchId
          ? []
          : where.id
            ? lots.filter((lot) => where.id!.in.includes(lot.id))
            : lots.map((lot) => ({ id: lot.id, batch: { medicineId: lot.batch.medicineId } }))
      ),
    },
    medicine: { findMany: vi.fn(async () => [{ id: 'med-a' }]) },
    packLevel: { findMany: vi.fn(async () => packLevels) },
    medicinePackMrp: { findMany: vi.fn(async () => []) },
    pharmacyStockBalance: { findMany: vi.fn(async () => balances) },
  };
}

const postedReceipt = {
  reference: 'GRN-0007',
  status: 'POSTED',
  lines: [
    { inventoryLotId: 'lot-a', acceptedCanonicalUnits: 1000, canonicalUnitsPerPack: 100 },
    // Fully rejected: no lot, no sticker.
    { inventoryLotId: null, acceptedCanonicalUnits: 0, canonicalUnitsPerPack: 100 },
    { inventoryLotId: 'lot-b', acceptedCanonicalUnits: 250, canonicalUnitsPerPack: 100 },
  ],
};

describe('DEV-90 shelf-label source', () => {
  it('prints one label per received pack from a posted goods receipt', async () => {
    const db = fakeDb(postedReceipt);
    const sheet = await readShelfLabelSheet(
      db as never,
      scope,
      { kind: 'RECEIPT', goodsReceiptId: 'grn-7' },
      at
    );
    expect(db.pharmacyGoodsReceipt.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'grn-7', organizationId: 'org-a', branchId: 'branch-a' },
      })
    );
    expect(sheet.title).toBe('Goods receipt GRN-0007');
    expect(sheet.rows.map((row) => [row.inventoryLotId, row.defaultCount])).toEqual([
      ['lot-a', 10],
      ['lot-b', 2],
    ]);
  });

  it('shows the current pack price and the counter strip price, with the scannable lot code', async () => {
    const sheet = await readShelfLabelSheet(
      fakeDb(postedReceipt) as never,
      scope,
      { kind: 'RECEIPT', goodsReceiptId: 'grn-7' },
      at
    );
    const row = sheet.rows[0]!;
    expect(row).toMatchObject({
      code: shelfLabelCode(41),
      name: 'Paracetamol',
      strength: '500 mg',
      // The sealed-pack price the counter charges for this lot (MED-08).
      packMrpMinor: 12_345,
      stripMrpMinor: priceFromLot({
        printedMrpMinor: 12_345,
        canonicalUnitsInPack: 100,
        canonicalUnitsPerSaleUnit: 10,
      }).unitPriceMinor,
      expiry: '2027-06-15',
      batchNumber: 'B-1',
      unavailableReason: null,
    });
    expect(row.packMrpMinor).toBe(
      priceFromLot({
        printedMrpMinor: 12_345,
        canonicalUnitsInPack: 100,
        canonicalUnitsPerSaleUnit: 100,
      }).unitPriceMinor
    );
  });

  it('marks a lot that cannot be sold so it is not printed', async () => {
    const sheet = await readShelfLabelSheet(
      fakeDb(postedReceipt) as never,
      scope,
      { kind: 'RECEIPT', goodsReceiptId: 'grn-7' },
      at
    );
    expect(sheet.rows[1]).toMatchObject({
      inventoryLotId: 'lot-b',
      expiry: '2027-03',
      unavailableReason: 'This batch is recalled.',
    });
  });

  it('refuses a receipt that is missing, from another branch, or not posted', async () => {
    await expect(
      readShelfLabelSheet(fakeDb(null) as never, scope, { kind: 'RECEIPT', goodsReceiptId: 'x' })
    ).rejects.toEqual(new ShelfLabelSourceError('NOT_FOUND'));
    for (const status of ['DRAFT', 'REVERSED', 'CANCELLED']) {
      await expect(
        readShelfLabelSheet(fakeDb({ ...postedReceipt, status }) as never, scope, {
          kind: 'RECEIPT',
          goodsReceiptId: 'x',
        })
      ).rejects.toEqual(new ShelfLabelSourceError('RECEIPT_NOT_POSTED'));
    }
  });

  it('lists the stocked lots of a medicine list, one label each by default', async () => {
    const db = fakeDb();
    const sheet = await readShelfLabelSheet(
      db as never,
      scope,
      { kind: 'MEDICINES', medicineIds: ['med-a', 'med-a'] },
      at
    );
    expect(sheet.rows.map((row) => [row.inventoryLotId, row.defaultCount])).toEqual([
      ['lot-a', 1],
      ['lot-b', 1],
    ]);
    expect(db.pharmacyInventoryLot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          branchId: 'branch-a',
          balances: { some: { onHandUnits: { gt: 0 } } },
        }),
      })
    );
  });

  it('only admits saleable medicines from a medicine list', async () => {
    const db = fakeDb();
    await readShelfLabelSheet(
      db as never,
      scope,
      { kind: 'MEDICINES', medicineIds: ['med-a'] },
      at
    );
    expect(db.medicine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-a', saleable: true }),
      })
    );
  });

  it('formats a Pakistan calendar expiry from the stored exclusive boundary', () => {
    expect(printedExpiryLabel(expiryInstant(new Date('2027-01-31T00:00:00Z'), 'DAY'), 'DAY')).toBe(
      '2027-01-31'
    );
    expect(
      printedExpiryLabel(expiryInstant(new Date('2027-12-01T00:00:00Z'), 'MONTH'), 'MONTH')
    ).toBe('2027-12');
    // A legacy UTC-midnight boundary reads the same day.
    expect(printedExpiryLabel(new Date('2027-02-01T00:00:00Z'), 'DAY')).toBe('2027-01-31');
  });

  it('has no strip price when the pack hierarchy has no strip level', () => {
    expect(
      stripPriceForLot({
        packLevels: [packLevels[0]!, { ...packLevels[2]!, parentPackLevelId: 'box' }],
        packLevelId: 'box',
        unitsPerPack: 10,
        printedMrpMinor: 1_000,
        roundingIncrementMinor: 1,
      })
    ).toBeNull();
    expect(
      stripPriceForLot({
        packLevels,
        packLevelId: 'box',
        unitsPerPack: 100,
        printedMrpMinor: 1_000,
        roundingIncrementMinor: 1,
      })
    ).toBe(100);
  });
});
