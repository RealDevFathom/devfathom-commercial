import { describe, expect, it } from 'vitest';

import {
  counterUnitNoun,
  describePackSetup,
  incrementRepeatScan,
  previewSaleLine,
  resolveCounterSaleUnits,
  saleUnitOptions,
  type PackLevelNode,
  type SaleUnitKind,
} from './counter-pricing';
import { PharmacyMedicineError, priceFromLot } from './medicine';

/** BOX(10 strips) → STRIP(10 tablets) → UNIT: 100 canonical units per box. */
const THREE_LEVEL: PackLevelNode[] = [
  { id: 'box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
  { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 },
  { id: 'unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
];

/** A bottle has no strip: BOTTLE(30 ml) → UNIT. */
const TWO_LEVEL: PackLevelNode[] = [
  { id: 'bottle', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 },
  { id: 'ml', level: 'UNIT', parentPackLevelId: 'bottle', unitsPerParent: 30 },
];

describe('saleUnitOptions (POS-03 toggle)', () => {
  it('sells a standalone receiving pack using its frozen canonical conversion', () => {
    const pack = { id: 'flat', level: 'STRIP', parentPackLevelId: null, unitsPerParent: 10 };
    expect(
      saleUnitOptions({ packLevels: [pack], rootPackLevelId: 'flat', unitsPerPack: 10 })
    ).toEqual([
      { kind: 'PACK', packLevelId: 'flat', levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 10 },
    ]);
    expect(() =>
      saleUnitOptions({ packLevels: [pack], rootPackLevelId: 'flat', unitsPerPack: 20 })
    ).toThrowError(PharmacyMedicineError);
  });
  it('sells a receipt at the hierarchy leaf as one canonical unit', () => {
    const options = saleUnitOptions({
      packLevels: THREE_LEVEL,
      rootPackLevelId: 'unit',
      unitsPerPack: 1,
    });
    expect(options).toEqual([
      { kind: 'PACK', packLevelId: 'unit', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
    ]);
    expect(
      previewSaleLine({
        option: options[0]!,
        quantity: 3,
        printedMrpMinor: 125,
        unitsPerPack: 1,
        availableUnits: 5,
      })
    ).toMatchObject({ canonicalUnits: 3, unitPriceMinor: 125, grossMinor: 375, sufficient: true });
  });

  it('rejects a leaf receipt that uses its parent conversion as units per pack', () => {
    expect(() =>
      saleUnitOptions({ packLevels: THREE_LEVEL, rootPackLevelId: 'unit', unitsPerPack: 10 })
    ).toThrowError(PharmacyMedicineError);
  });

  it('derives pack, strip and unit from the received pack hierarchy', () => {
    expect(
      saleUnitOptions({ packLevels: THREE_LEVEL, rootPackLevelId: 'box', unitsPerPack: 100 })
    ).toEqual([
      { kind: 'PACK', packLevelId: 'box', levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 100 },
      { kind: 'STRIP', packLevelId: 'strip', levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 10 },
      { kind: 'UNIT', packLevelId: 'unit', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
    ]);
  });

  it('offers no strip when the medicine genuinely has none', () => {
    const options = saleUnitOptions({
      packLevels: TWO_LEVEL,
      rootPackLevelId: 'bottle',
      unitsPerPack: 30,
    });
    expect(options.map((option) => option.kind)).toEqual(['PACK', 'UNIT']);
    expect(options[1]!.canonicalUnitsPerSaleUnit).toBe(1);
  });

  it('starts at the lot’s own level, never above it', () => {
    // A lot received as strips must not offer the box the branch never received.
    const options = saleUnitOptions({
      packLevels: THREE_LEVEL,
      rootPackLevelId: 'strip',
      unitsPerPack: 10,
    });
    expect(options.map((option) => option.packLevelId)).toEqual(['strip', 'unit']);
    expect(options[0]!.kind).toBe('PACK');
  });

  it('refuses a hierarchy that disagrees with the received lot', () => {
    // The chain says 100 units per box; the lot claims 60. One of them is wrong
    // and neither can be used to derive a price.
    expect(() =>
      saleUnitOptions({ packLevels: THREE_LEVEL, rootPackLevelId: 'box', unitsPerPack: 60 })
    ).toThrowError(PharmacyMedicineError);
  });

  it('refuses an ambiguous hierarchy with two children at one level', () => {
    const ambiguous: PackLevelNode[] = [
      ...THREE_LEVEL,
      { id: 'strip-b', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 5 },
    ];
    expect(() =>
      saleUnitOptions({ packLevels: ambiguous, rootPackLevelId: 'box', unitsPerPack: 100 })
    ).toThrowError(PharmacyMedicineError);
  });

  it('refuses an unknown root pack level', () => {
    expect(() =>
      saleUnitOptions({ packLevels: THREE_LEVEL, rootPackLevelId: 'missing', unitsPerPack: 100 })
    ).toThrowError(PharmacyMedicineError);
  });
});

describe('previewSaleLine (exact quantity and price preview)', () => {
  const options = saleUnitOptions({
    packLevels: THREE_LEVEL,
    rootPackLevelId: 'box',
    unitsPerPack: 100,
  });
  const [pack, strip, unit] = options;

  it('quotes exactly what priceFromLot would charge, per sale unit', () => {
    for (const option of options) {
      const preview = previewSaleLine({
        option,
        quantity: 1,
        printedMrpMinor: 25_000,
        unitsPerPack: 100,
        availableUnits: 1_000,
      });
      const expected = priceFromLot({
        printedMrpMinor: 25_000,
        canonicalUnitsInPack: 100,
        canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
      });
      expect(preview.unitPriceMinor).toBe(expected.unitPriceMinor);
      expect(preview.proRataCeilingMinor).toBe(expected.proRataCeilingMinor);
    }
  });

  it('quotes the printed MRP for a full pack when the MRP is not divisible by its units', () => {
    const threeUnitOptions = saleUnitOptions({
      packLevels: [
        { id: 'pack-3', parentPackLevelId: null, level: 'BOX', unitsPerParent: 1 },
        { id: 'unit-3', parentPackLevelId: 'pack-3', level: 'TABLET', unitsPerParent: 3 },
      ],
      rootPackLevelId: 'pack-3',
      unitsPerPack: 3,
    });
    const preview = previewSaleLine({
      option: threeUnitOptions[0]!,
      quantity: 1,
      printedMrpMinor: 1_000,
      unitsPerPack: 3,
      availableUnits: 3,
    });

    expect(preview.option.kind).toBe('PACK');
    expect(preview.unitPriceMinor).toBe(1_000);
    expect(preview.grossMinor).toBe(1_000);
  });

  it('multiplies canonical units and gross by the quantity', () => {
    const preview = previewSaleLine({
      option: strip!,
      quantity: 3,
      printedMrpMinor: 25_000,
      unitsPerPack: 100,
      availableUnits: 1_000,
    });
    expect(preview.canonicalUnits).toBe(30);
    expect(preview.unitPriceMinor).toBe(2_500);
    expect(preview.grossMinor).toBe(7_500);
    expect(preview.sufficient).toBe(true);
    expect(preview.shortfallUnits).toBe(0);
  });

  it('never quotes a unit price above the pro-rata ceiling', () => {
    // 999 / 100 = 9.99 per unit; the ceiling floors to 9 and rounding keeps it there.
    const preview = previewSaleLine({
      option: unit!,
      quantity: 1,
      printedMrpMinor: 999,
      unitsPerPack: 100,
      availableUnits: 100,
    });
    expect(preview.unitPriceMinor).toBeLessThanOrEqual(preview.proRataCeilingMinor);
    expect(preview.unitPriceMinor).toBe(9);
  });

  it('respects an approved rounding increment', () => {
    const preview = previewSaleLine({
      option: unit!,
      quantity: 1,
      printedMrpMinor: 999,
      unitsPerPack: 100,
      roundingIncrementMinor: 5,
      availableUnits: 100,
    });
    // Floors 9 down to the nearest 5 rather than rounding up past the ceiling.
    expect(preview.unitPriceMinor).toBe(5);
    expect(preview.proRataCeilingMinor).toBe(9);
  });

  it('reports the exact shortfall instead of silently allowing the line', () => {
    const preview = previewSaleLine({
      option: pack!,
      quantity: 2,
      printedMrpMinor: 25_000,
      unitsPerPack: 100,
      availableUnits: 150,
    });
    expect(preview.canonicalUnits).toBe(200);
    expect(preview.sufficient).toBe(false);
    expect(preview.shortfallUnits).toBe(50);
  });

  it('rejects a non-integer or non-positive quantity', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        previewSaleLine({
          option: unit!,
          quantity,
          printedMrpMinor: 100,
          unitsPerPack: 100,
          availableUnits: 10,
        })
      ).toThrowError(PharmacyMedicineError);
    }
  });

  it('rejects a negative available-units figure', () => {
    expect(() =>
      previewSaleLine({
        option: unit!,
        quantity: 1,
        printedMrpMinor: 100,
        unitsPerPack: 100,
        availableUnits: -1,
      })
    ).toThrowError(PharmacyMedicineError);
  });
});

describe('incrementRepeatScan (POS-03: repeat scan increments the same unit)', () => {
  type CartLine = {
    medicineId: string;
    packLevelId: string;
    saleUnit: SaleUnitKind;
    quantity: number;
  };
  const line: CartLine = {
    medicineId: 'm1',
    packLevelId: 'strip',
    saleUnit: 'STRIP',
    quantity: 1,
  };

  it('raises the quantity of a matching line instead of stacking a second', () => {
    const next = incrementRepeatScan([line], {
      medicineId: 'm1',
      packLevelId: 'strip',
      saleUnit: 'STRIP',
    });
    expect(next).toHaveLength(1);
    expect(next[0]!.quantity).toBe(2);
  });

  it('adds a separate line when the sale unit differs', () => {
    const next = incrementRepeatScan([line], {
      medicineId: 'm1',
      packLevelId: 'unit',
      saleUnit: 'UNIT',
    });
    expect(next).toHaveLength(2);
    expect(next[0]!.quantity).toBe(1);
    expect(next[1]!.quantity).toBe(1);
  });

  it('adds a separate line for a different medicine', () => {
    const next = incrementRepeatScan([line], {
      medicineId: 'm2',
      packLevelId: 'strip',
      saleUnit: 'STRIP',
    });
    expect(next).toHaveLength(2);
  });

  it('honours an explicit step and leaves the input untouched', () => {
    const source = [line];
    const next = incrementRepeatScan(source, {
      medicineId: 'm1',
      packLevelId: 'strip',
      saleUnit: 'STRIP',
      quantity: 4,
    });
    expect(next[0]!.quantity).toBe(5);
    expect(source[0]!.quantity).toBe(1);
  });
});

describe('resolveCounterSaleUnits (DEV-724 pack mismatch fallback)', () => {
  const at = new Date('2026-11-15T00:00:00.000Z');

  /** The server's own derivation in `addSaleLine`: priced from the lot alone. */
  function serverUnitPrice(canonicalUnitsPerSaleUnit: number) {
    return priceFromLot({
      printedMrpMinor: 50_000,
      canonicalUnitsInPack: 100,
      canonicalUnitsPerSaleUnit,
    }).unitPriceMinor;
  }

  it('keeps the received lot hierarchy when it agrees with the setup', () => {
    const resolved = resolveCounterSaleUnits({
      packLevels: THREE_LEVEL,
      lotPackLevelId: 'box',
      lotPackLevelLabel: 'BOX',
      lotUnitsPerPack: 100,
      dosageForm: 'Tablet',
      at,
    });
    expect(resolved.packMismatch).toBeNull();
    expect(resolved.saleUnits.map((option) => option.kind)).toEqual(['PACK', 'STRIP', 'UNIT']);
  });

  it('sells a lot received against another pack level through the medicine setup', () => {
    // The lot points at a standalone 100-tablet box the setup no longer holds.
    expect(() =>
      saleUnitOptions({ packLevels: THREE_LEVEL, rootPackLevelId: 'old-box', unitsPerPack: 100 })
    ).toThrowError(PharmacyMedicineError);
    const resolved = resolveCounterSaleUnits({
      packLevels: THREE_LEVEL,
      lotPackLevelId: 'old-box',
      lotPackLevelLabel: 'BOX',
      lotUnitsPerPack: 100,
      dosageForm: 'Tablet',
      at,
    });
    expect(resolved.packMismatch).toBeNull();
    expect(resolved.saleUnits).toEqual([
      { kind: 'PACK', packLevelId: 'box', levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 100 },
      { kind: 'STRIP', packLevelId: 'strip', levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 10 },
      { kind: 'UNIT', packLevelId: 'unit', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
    ]);
    // Client preview and server line price agree for every offered unit.
    for (const option of resolved.saleUnits) {
      const preview = previewSaleLine({
        option,
        quantity: 1,
        printedMrpMinor: 50_000,
        unitsPerPack: 100,
        availableUnits: 300,
      });
      expect(preview.unitPriceMinor).toBe(serverUnitPrice(option.canonicalUnitsPerSaleUnit));
    }
  });

  it('falls back when the lot pack size disagrees, offering only units that divide it', () => {
    // Received as a box of 120 against a 10 × 10 setup: the 100-tablet box is not offered.
    const resolved = resolveCounterSaleUnits({
      packLevels: THREE_LEVEL,
      lotPackLevelId: 'box',
      lotPackLevelLabel: 'BOX',
      lotUnitsPerPack: 120,
      dosageForm: 'Tablet',
      at,
    });
    expect(resolved.packMismatch).toBeNull();
    expect(
      resolved.saleUnits.map((option) => [option.kind, option.canonicalUnitsPerSaleUnit])
    ).toEqual([
      ['STRIP', 10],
      ['UNIT', 1],
    ]);
    for (const option of resolved.saleUnits) {
      expect(() =>
        priceFromLot({
          printedMrpMinor: 60_000,
          canonicalUnitsInPack: 120,
          canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
        })
      ).not.toThrow();
    }
  });

  it('offers only fallback units every sellable lot can price, since FEFO may draw on them', () => {
    // The recommended lot is a 100-tablet box; the next lot FEFO may allocate
    // from was received as strips of 10. The server prices each allocated lot
    // with priceFromLot, which refuses a 100-tablet unit for the 10-tablet lot.
    expect(() =>
      priceFromLot({
        printedMrpMinor: 5_000,
        canonicalUnitsInPack: 10,
        canonicalUnitsPerSaleUnit: 100,
      })
    ).toThrowError(PharmacyMedicineError);
    const resolved = resolveCounterSaleUnits({
      packLevels: THREE_LEVEL,
      lotPackLevelId: 'old-box',
      lotPackLevelLabel: 'BOX',
      lotUnitsPerPack: 100,
      otherLotUnitsPerPack: [10],
      dosageForm: 'Tablet',
      at,
    });
    expect(resolved.saleUnits.map((option) => option.kind)).toEqual(['STRIP', 'UNIT']);
    for (const option of resolved.saleUnits) {
      for (const canonicalUnitsInPack of [100, 10]) {
        expect(() =>
          priceFromLot({
            printedMrpMinor: 5_000,
            canonicalUnitsInPack,
            canonicalUnitsPerSaleUnit: option.canonicalUnitsPerSaleUnit,
          })
        ).not.toThrow();
      }
    }
  });

  it('ignores superseded pack versions when falling back to the setup', () => {
    const revised = [
      ...THREE_LEVEL,
      {
        id: 'strip-old',
        level: 'STRIP',
        parentPackLevelId: 'box',
        unitsPerParent: 5,
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      },
    ];
    const resolved = resolveCounterSaleUnits({
      packLevels: revised,
      lotPackLevelId: 'box',
      lotPackLevelLabel: 'BOX',
      lotUnitsPerPack: 100,
      dosageForm: 'Tablet',
      at,
    });
    expect(resolved.saleUnits.map((option) => option.packLevelId)).toEqual([
      'box',
      'strip',
      'unit',
    ]);
  });

  it('describes an unpriceable mismatch in shop words', () => {
    const standalone = [
      { id: 'strip', level: 'STRIP', parentPackLevelId: null, unitsPerParent: 10 },
    ];
    expect(
      resolveCounterSaleUnits({
        packLevels: standalone,
        lotPackLevelId: 'strip',
        lotPackLevelLabel: 'STRIP',
        lotUnitsPerPack: 15,
        dosageForm: 'Tablet',
        at,
      })
    ).toEqual({
      saleUnits: [],
      packMismatch: { received: '1 strip = 15 tablets', setup: '1 strip = 10 tablets' },
    });
    const ambiguous = [
      ...THREE_LEVEL,
      { id: 'strip-2', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 5 },
    ];
    expect(
      resolveCounterSaleUnits({
        packLevels: ambiguous,
        lotPackLevelId: 'box',
        lotPackLevelLabel: 'BOX',
        lotUnitsPerPack: 100,
        dosageForm: 'Capsule',
        at,
      })
    ).toEqual({
      saleUnits: [],
      packMismatch: { received: '1 box = 100 capsules', setup: null },
    });
  });

  it('describes a multi-level setup outermost first', () => {
    expect(describePackSetup(THREE_LEVEL, counterUnitNoun('Tablet'))).toBe(
      '1 box = 10 strips × 10 tablets'
    );
    expect(describePackSetup(TWO_LEVEL, counterUnitNoun('Syrup'))).toBe('1 box = 30 units');
    const carton: PackLevelNode[] = [
      { id: 'carton', level: 'CARTON', parentPackLevelId: null, unitsPerParent: 1 },
      { id: 'box', level: 'BOX', parentPackLevelId: 'carton', unitsPerParent: 10 },
      { id: 'unit', level: 'UNIT', parentPackLevelId: 'box', unitsPerParent: 10 },
    ];
    expect(describePackSetup(carton, counterUnitNoun('Tablet'))).toBe(
      '1 carton = 10 boxes × 10 tablets'
    );
  });
});
