import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { renderStrengthValue, searchCounterCatalog } from './counter';

describe('renderStrengthValue (POS-02 strength display)', () => {
  it('never trims a trailing zero that carries magnitude', () => {
    // The defect this guards: a positional trailing-zero trim turns 500 into 5,
    // a hundredfold strength error on the field a pharmacist reads back.
    expect(renderStrengthValue('500')).toBe('500');
    expect(renderStrengthValue('50')).toBe('50');
    expect(renderStrengthValue('1000')).toBe('1000');
    expect(renderStrengthValue(500)).toBe('500');
  });

  it('trims only fractional trailing zeros, as a Decimal renders them', () => {
    expect(renderStrengthValue('500.000000')).toBe('500');
    expect(renderStrengthValue('2.500000')).toBe('2.5');
    expect(renderStrengthValue('0.125000')).toBe('0.125');
    expect(renderStrengthValue('10.00')).toBe('10');
  });

  it('leaves a value with no trailing zeros untouched', () => {
    expect(renderStrengthValue('2.5')).toBe('2.5');
    expect(renderStrengthValue('125')).toBe('125');
  });
});

const labelScope = { organizationId: 'org-a', branchId: 'branch-a' };
const labelAt = new Date('2026-10-31T09:00:00.000Z');

function labelCatalog() {
  const presentations = [
    { id: 'presentation-fefo', presentation: 'Pack of 10', dosageForm: 'Tablet', route: 'Oral' },
    { id: 'presentation-labelled', presentation: 'Box of 30', dosageForm: 'Tablet', route: 'Oral' },
  ];
  const lots = [
    {
      id: 'lot-fefo', packLevelId: 'pack-fefo', unitsPerPack: 10, printedMrpMinor: 1000,
      receivedAt: new Date('2026-09-01'),
      batch: { medicineId: 'med-a', batchNumber: 'A', state: 'ACTIVE', expiresAt: new Date('2027-01-01') },
    },
    {
      id: 'lot-labelled', packLevelId: 'pack-labelled', unitsPerPack: 30, printedMrpMinor: 9000,
      receivedAt: new Date('2026-10-01'),
      batch: { medicineId: 'med-a', batchNumber: 'B', state: 'ACTIVE', expiresAt: new Date('2027-06-01') },
    },
  ];
  const medicine = {
    id: 'med-a', productName: 'Medicine', brandName: null, manufacturer: null, strengths: [], presentations,
    rx: false, otc: true, restricted: false, controlled: false, highAlert: false, lasa: false, coldChain: false,
  };
  const db = {
    medicineBarcode: { findFirst: vi.fn().mockResolvedValue(null) },
    medicine: { findMany: vi.fn().mockResolvedValue([medicine]) },
    pharmacyInventoryLot: {
      findFirst: vi.fn().mockResolvedValue({ id: 'lot-labelled', batch: { medicineId: 'med-a' } }),
      findMany: vi.fn().mockResolvedValue(lots),
    },
    packLevel: { findMany: vi.fn().mockResolvedValue([
      { id: 'pack-fefo', level: 'BOX', parentPackLevelId: null, unitsPerParent: 10, presentationId: presentations[0]!.id },
      { id: 'pack-labelled', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1, presentationId: presentations[1]!.id },
      { id: 'strip', level: 'STRIP', parentPackLevelId: 'pack-labelled', unitsPerParent: 3, presentationId: presentations[1]!.id },
      { id: 'unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10, presentationId: presentations[1]!.id },
    ]) },
    medicinePackMrp: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyStockBalance: { findMany: vi.fn().mockResolvedValue([
      { inventoryLotId: 'lot-fefo', stockLocationId: 'store-a', disposition: 'AVAILABLE', onHandUnits: 100 },
      { inventoryLotId: 'lot-labelled', stockLocationId: 'store-b', disposition: 'AVAILABLE', onHandUnits: 60 },
    ]) },
    pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue([
      { id: 'store-a', kind: 'STORE', code: 'A', name: 'Store A' },
      { id: 'store-b', kind: 'STORE', code: 'B', name: 'Store B' },
    ]) },
  };
  return { db, lots, medicine };
}

describe('#719 exact-lot counter selection', () => {
  it('uses the labelled lot presentation, conversion, MRP, availability and location, keeping FEFO separately', async () => {
    const { db } = labelCatalog();
    const result = await searchCounterCatalog(db as unknown as ScopedDb, labelScope, { query: '7100000000000041', at: labelAt });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row).toMatchObject({
      labelLotId: 'lot-labelled', recommendedLotId: 'lot-fefo', presentationId: 'presentation-labelled',
      packLevelId: 'pack-labelled', unitsPerPack: 30, printedMrpMinor: 9000,
      onHandUnits: 60, batchNumber: 'B', nearestSafeExpiry: '2027-06-01T00:00:00.000Z',
      storage: { locationCode: 'B' },
      fefoSelection: { unitsPerPack: 10, printedMrpMinor: 1000, onHandUnits: 160 },
    });
    expect(row.saleUnits[0]).toMatchObject({ kind: 'PACK', canonicalUnitsPerSaleUnit: 30 });
    expect(row.saleableUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PACK', unitPriceMinor: 9000, wholeUnits: 2 }),
      expect.objectContaining({ kind: 'STRIP', unitPriceMinor: 3000, wholeUnits: 6 }),
    ]));
  });

  it.each(['QUARANTINED', 'RECALLED'])('never previews another lot stock for a %s labelled batch', async (state) => {
    const { db, lots } = labelCatalog();
    lots[1]!.batch.state = state;
    const result = await searchCounterCatalog(db as unknown as ScopedDb, labelScope, { query: '7100000000000041', at: labelAt });
    expect(result.rows[0]).toMatchObject({ labelLotId: 'lot-labelled', onHandUnits: 0, unitsPerPack: 30, blocked: [state] });
    expect(result.rows[0]!.saleableUnits.every((unit) => unit.wholeUnits === 0)).toBe(true);
  });

  it.each([true, false])('preserves a registered barcode with shelf-label syntax (alias exists: %s)', async (exists) => {
    const { db, medicine } = labelCatalog();
    db.medicineBarcode.findFirst.mockResolvedValue({ presentation: { medicineId: 'registered-medicine' } });
    db.medicine.findMany.mockResolvedValue([{ ...medicine, id: 'registered-medicine' }]);
    if (!exists) db.pharmacyInventoryLot.findFirst.mockResolvedValue(null);
    const result = await searchCounterCatalog(db as unknown as ScopedDb, labelScope, { query: '7100000000000041', at: labelAt });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ medicineId: 'registered-medicine', matchedOn: 'BARCODE' });
    expect(result.rows[0]).not.toHaveProperty('labelLotId');
    expect(db.pharmacyInventoryLot.findFirst).not.toHaveBeenCalled();
  });
});
