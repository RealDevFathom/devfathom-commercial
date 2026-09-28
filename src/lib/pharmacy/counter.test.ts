import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { renderStrengthValue, searchCounterCatalog } from './counter';

describe('counter search FEFO location projection (mock database)', () => {
  function fixture(locations: Array<{ id: string; kind: string; code: string; name: string }>) {
    const medicine = {
      id: 'med-a',
      productName: 'Synthetic medicine',
      brandName: null,
      manufacturer: null,
      strengths: [],
      presentations: [
        { id: 'presentation-a', presentation: 'Tablets', dosageForm: null, route: null },
      ],
      rx: false,
      otc: true,
      controlled: false,
      restricted: false,
      highAlert: false,
      lasa: false,
      coldChain: false,
    };
    const lot = (id: string, expiresAt: string, state = 'ACTIVE') => ({
      id,
      packLevelId: 'unit',
      unitsPerPack: 1,
      printedMrpMinor: 100,
      receivedAt: new Date('2026-01-01'),
      batch: { medicineId: 'med-a', batchNumber: id, expiresAt: new Date(expiresAt), state },
    });
    const db = {
      medicineBarcode: { findFirst: vi.fn().mockResolvedValue(null) },
      medicineAlias: { findMany: vi.fn().mockResolvedValue([]) },
      medicineStrengthComponent: { findMany: vi.fn().mockResolvedValue([]) },
      presentation: { findMany: vi.fn().mockResolvedValue([]) },
      medicine: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'med-a' }])
          .mockResolvedValue([medicine]),
      },
      pharmacyInventoryLot: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            lot('late', '2028-01-01'),
            lot('early', '2027-01-01'),
            lot('recalled', '2026-12-01', 'RECALLED'),
          ]),
      },
      packLevel: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'unit',
            level: 'UNIT',
            parentPackLevelId: null,
            unitsPerParent: 1,
            presentationId: 'presentation-a',
          },
        ]),
      },
      medicinePackMrp: { findMany: vi.fn().mockResolvedValue([]) },
      pharmacyStockBalance: {
        findMany: vi.fn().mockResolvedValue([
          {
            inventoryLotId: 'late',
            stockLocationId: 'back',
            disposition: 'AVAILABLE',
            onHandUnits: 90,
          },
          {
            inventoryLotId: 'early',
            stockLocationId: 'shelf',
            disposition: 'AVAILABLE',
            onHandUnits: 200,
          },
          {
            inventoryLotId: 'recalled',
            stockLocationId: 'quarantine',
            disposition: 'AVAILABLE',
            onHandUnits: 999,
          },
        ]),
      },
      pharmacyStockLocation: { findMany: vi.fn().mockResolvedValue(locations) },
    };
    // Deliberately read-only test double: unexpected writes have no implementation.
    return { db: db as unknown as ScopedDb, readLocations: db.pharmacyStockLocation.findMany };
  }

  it('returns the actual recommended-lot location name/code and excludes recalled availability', async () => {
    const { db, readLocations } = fixture([
      { id: 'back', kind: 'STORE', code: 'BACK', name: 'Back store' },
      { id: 'shelf', kind: 'RACK_BIN', code: 'R2-S3', name: 'Rack 2 / Shelf 3' },
    ]);
    const result = await searchCounterCatalog(
      db,
      { organizationId: 'org-a', branchId: 'branch-a' },
      { query: 'Synthetic', at: new Date('2026-09-12') }
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      recommendedLotId: 'early',
      batchNumber: 'early',
      onHandUnits: 290,
      nearestSafeExpiry: '2027-01-01T00:00:00.000Z',
      storage: {
        locationName: 'Rack 2 / Shelf 3',
        locationCode: 'R2-S3',
        locationKind: 'RACK_BIN',
      },
    });
    expect(readLocations).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true, kind: true, code: true, name: true } })
    );
  });

  it('returns nulls when the recommended location is absent instead of borrowing another shelf', async () => {
    const { db } = fixture([{ id: 'back', kind: 'STORE', code: 'BACK', name: 'Back store' }]);
    const result = await searchCounterCatalog(
      db,
      { organizationId: 'org-a', branchId: 'branch-a' },
      { query: 'Synthetic', at: new Date('2026-09-12') }
    );
    expect(result.rows[0]).toMatchObject({
      recommendedLotId: 'early',
      onHandUnits: 290,
      storage: { locationName: null, locationCode: null, locationKind: null },
    });
  });
});

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
