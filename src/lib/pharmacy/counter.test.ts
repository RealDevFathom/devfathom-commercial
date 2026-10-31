import { describe, expect, it } from 'vitest';

import { renderStrengthValue, searchCounterCatalog } from './counter';
import { planAllocation } from './inventory';
import { priceFromLot } from './sales';

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

describe('counter quote and allocation FEFO agreement', () => {
  it.each([
    { name: 'oldest receipt before lot ID', sameReceipt: false, reverse: false },
    { name: 'oldest receipt with reversed query results', sameReceipt: false, reverse: true },
    { name: 'lot ID for equal receipt dates', sameReceipt: true, reverse: true },
  ])('quotes the allocated price using $name', async ({ sameReceipt, reverse }) => {
    const scope = { organizationId: 'org-a', branchId: 'branch-a' };
    const at = new Date('2026-01-01');
    const lots = [
      {
        id: 'a-newer',
        packLevelId: 'pack-a',
        unitsPerPack: 1,
        printedMrpMinor: 200,
        receivedAt: new Date(sameReceipt ? '2025-01-01' : '2025-02-01'),
        batch: {
          medicineId: 'medicine-a',
          batchNumber: 'batch-a',
          expiresAt: new Date('2030-01-01'),
          state: 'ACTIVE' as const,
        },
      },
      {
        id: 'z-older',
        packLevelId: 'pack-a',
        unitsPerPack: 1,
        printedMrpMinor: 100,
        receivedAt: new Date('2025-01-01'),
        batch: {
          medicineId: 'medicine-a',
          batchNumber: 'batch-z',
          expiresAt: new Date('2030-01-01'),
          state: 'ACTIVE' as const,
        },
      },
    ];
    if (reverse) lots.reverse();
    const candidates = lots.flatMap((lot) =>
      ['shelf-z', 'shelf-a'].map((stockLocationId) => ({
        ...scope,
        inventoryLotId: lot.id,
        stockLocationId,
        expiresAt: lot.batch.expiresAt,
        receivedAt: lot.receivedAt,
        batchState: lot.batch.state,
        disposition: 'AVAILABLE' as const,
        availableUnits: 10,
      }))
    );
    const db = {
      medicineBarcode: { findFirst: async () => null },
      medicineAlias: { findMany: async () => [] },
      medicineStrengthComponent: { findMany: async () => [] },
      presentation: { findMany: async () => [] },
      medicine: {
        findMany: async () => [
          {
            id: 'medicine-a',
            productName: 'Paracetamol',
            strengths: [],
            presentations: [{ id: 'presentation-a', presentation: 'Tablet' }],
          },
        ],
      },
      pharmacyInventoryLot: { findMany: async () => lots },
      pharmacyStockBalance: {
        findMany: async () => candidates.map((c) => ({ ...c, onHandUnits: c.availableUnits })),
      },
      pharmacyStockLocation: {
        findMany: async () => [
          { id: 'shelf-z', name: 'Shelf Z' },
          { id: 'shelf-a', name: 'Shelf A' },
        ],
      },
      packLevel: {
        findMany: async () => [
          {
            id: 'pack-a',
            presentationId: 'presentation-a',
            parentPackLevelId: null,
            level: 'UNIT',
            unitsPerParent: 1,
          },
        ],
      },
      medicinePackMrp: { findMany: async () => [] },
    };

    const { rows } = await searchCounterCatalog(db as never, scope, { query: 'Para', at });
    const plan = planAllocation({ candidates, requiredUnits: 1, scope: { ...scope, at } });
    const allocatedLot = lots.find((lot) => lot.id === plan.allocations[0]!.inventoryLotId)!;
    const postedPrice = priceFromLot({
      printedMrpMinor: allocatedLot.printedMrpMinor,
      canonicalUnitsInPack: allocatedLot.unitsPerPack,
      canonicalUnitsPerSaleUnit: 1,
    });

    expect(plan.recommendedLotId).toBe(sameReceipt ? 'a-newer' : 'z-older');
    expect(rows[0]!.recommendedLotId).toBe(plan.recommendedLotId);
    expect(rows[0]!.saleableUnits[0]!.unitPriceMinor).toBe(postedPrice.unitPriceMinor);
    expect(rows[0]!.storage.locationName).toBe('Shelf A');
  });
});
