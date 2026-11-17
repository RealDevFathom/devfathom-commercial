import { describe, expect, it } from 'vitest';

import {
  counterUnitNoun,
  describePackSetup,
  incrementRepeatScan,
  looseSaleUnitOption,
  lotSaleUnitOptions,
  packLevelCanonicalUnits,
  preferredSaleUnitOption,
  previewSaleLine,
  resolveCounterSaleUnits,
  saleUnitLabel,
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
      { kind: 'UNIT', packLevelId: 'flat', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
    ]);
    expect(() =>
      saleUnitOptions({ packLevels: [pack], rootPackLevelId: 'flat', unitsPerPack: 20 })
    ).toThrowError(PharmacyMedicineError);
  });

  it('offers no separate loose unit for a standalone pack of one canonical unit', () => {
    const pack = { id: 'vial', level: 'BOX', parentPackLevelId: null, unitsPerParent: 1 };
    expect(
      saleUnitOptions({ packLevels: [pack], rootPackLevelId: 'vial', unitsPerPack: 1 })
    ).toEqual([
      { kind: 'PACK', packLevelId: 'vial', levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 1 },
    ]);
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
    // Anchored at the strip, the outermost level that divides the lot: one PACK, one UNIT.
    expect(
      resolved.saleUnits.map((option) => [
        option.kind,
        option.levelLabel,
        option.canonicalUnitsPerSaleUnit,
      ])
    ).toEqual([
      ['PACK', 'STRIP', 10],
      ['UNIT', 'UNIT', 1],
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
    expect(resolved.saleUnits.map((option) => [option.kind, option.levelLabel])).toEqual([
      ['PACK', 'STRIP'],
      ['UNIT', 'UNIT'],
    ]);
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

  it('anchors a four-level setup at the received box so kinds stay unique', () => {
    const fourLevel: PackLevelNode[] = [
      { id: 'carton', level: 'CARTON', parentPackLevelId: null, unitsPerParent: 1 },
      { id: 'box', level: 'BOX', parentPackLevelId: 'carton', unitsPerParent: 5 },
      { id: 'strip', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 10 },
      { id: 'unit', level: 'UNIT', parentPackLevelId: 'strip', unitsPerParent: 10 },
    ];
    const resolved = resolveCounterSaleUnits({
      packLevels: fourLevel,
      lotPackLevelId: 'old-box',
      lotPackLevelLabel: 'BOX',
      lotUnitsPerPack: 100,
      dosageForm: 'Tablet',
      at,
    });
    expect(
      resolved.saleUnits.map((option) => [
        option.kind,
        option.packLevelId,
        option.canonicalUnitsPerSaleUnit,
      ])
    ).toEqual([
      ['PACK', 'box', 100],
      ['STRIP', 'strip', 10],
      ['UNIT', 'unit', 1],
    ]);
  });

  it('re-links children of a revised pack level to its current version', () => {
    // revisePackLevel closes `strip-v1` and creates `strip-v2` in the same
    // version group; the unit level still points at the closed `strip-v1`.
    const revised = [
      {
        id: 'box',
        level: 'BOX',
        parentPackLevelId: null,
        unitsPerParent: 1,
        versionGroupId: 'g-box',
      },
      {
        id: 'strip-v1',
        level: 'STRIP',
        parentPackLevelId: 'box',
        unitsPerParent: 5,
        versionGroupId: 'g-strip',
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'strip-v2',
        level: 'STRIP',
        parentPackLevelId: 'box',
        unitsPerParent: 10,
        versionGroupId: 'g-strip',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      },
      {
        id: 'unit',
        level: 'UNIT',
        parentPackLevelId: 'strip-v1',
        unitsPerParent: 10,
        versionGroupId: 'g-unit',
      },
    ];
    const resolved = resolveCounterSaleUnits({
      packLevels: revised,
      lotPackLevelId: 'old-box',
      lotPackLevelLabel: 'BOX',
      lotUnitsPerPack: 100,
      dosageForm: 'Tablet',
      at,
    });
    expect(resolved.packMismatch).toBeNull();
    expect(
      resolved.saleUnits.map((option) => [
        option.kind,
        option.packLevelId,
        option.canonicalUnitsPerSaleUnit,
      ])
    ).toEqual([
      ['PACK', 'box', 100],
      ['STRIP', 'strip-v2', 10],
      ['UNIT', 'unit', 1],
    ]);
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

  it('falls back to the lot’s own sealed pack and loose unit when the setup cannot price it', () => {
    // A standalone 10-tablet strip setup cannot divide a 15-tablet lot, and a
    // setup with two strips under one box is ambiguous: both keep DEV-717's
    // sealed-pack-plus-loose fallback instead of becoming unsellable.
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
      saleUnits: [
        { kind: 'PACK', packLevelId: 'strip', levelLabel: 'STRIP', canonicalUnitsPerSaleUnit: 15 },
        { kind: 'UNIT', packLevelId: 'strip', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
      ],
      packMismatch: null,
    });
    const ambiguous = [
      ...THREE_LEVEL,
      { id: 'strip-2', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 5 },
    ];
    // A later 10-tablet lot cannot price the 100-tablet pack, so only loose is offered.
    expect(
      resolveCounterSaleUnits({
        packLevels: ambiguous,
        lotPackLevelId: 'box',
        lotPackLevelLabel: 'BOX',
        lotUnitsPerPack: 100,
        otherLotUnitsPerPack: [10],
        dosageForm: 'Capsule',
        at,
      }).saleUnits.map((option) => [option.kind, option.canonicalUnitsPerSaleUnit])
    ).toEqual([['UNIT', 1]]);
  });

  it('describes an unusable lot conversion in shop words', () => {
    const ambiguous = [
      ...THREE_LEVEL,
      { id: 'strip-2', level: 'STRIP', parentPackLevelId: 'box', unitsPerParent: 5 },
    ];
    expect(
      resolveCounterSaleUnits({
        packLevels: ambiguous,
        lotPackLevelId: 'box',
        lotPackLevelLabel: 'BOX',
        lotUnitsPerPack: 0,
        dosageForm: 'Capsule',
        at,
      })
    ).toEqual({
      saleUnits: [],
      packMismatch: { received: '1 box = 0 capsules', setup: null },
    });
    const standalone = [
      { id: 'strip', level: 'STRIP', parentPackLevelId: null, unitsPerParent: 10 },
    ];
    expect(
      resolveCounterSaleUnits({
        packLevels: standalone,
        lotPackLevelId: 'strip',
        lotPackLevelLabel: 'STRIP',
        lotUnitsPerPack: 0,
        dosageForm: 'Tablet',
        at,
      }).packMismatch
    ).toEqual({ received: '1 strip = 0 tablets', setup: '1 strip = 10 tablets' });
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

describe('lotSaleUnitOptions (pack table disagrees with the lot)', () => {
  it('keeps the sealed pack and the loose unit from the lot’s frozen conversion', () => {
    expect(lotSaleUnitOptions({ packLevelId: 'box', levelLabel: 'BOX', unitsPerPack: 60 })).toEqual(
      [
        { kind: 'PACK', packLevelId: 'box', levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 60 },
        { kind: 'UNIT', packLevelId: 'box', levelLabel: 'UNIT', canonicalUnitsPerSaleUnit: 1 },
      ]
    );
  });

  it('prices the loose unit pro rata, never above the printed MRP share', () => {
    const [, loose] = lotSaleUnitOptions({
      packLevelId: 'box',
      levelLabel: 'BOX',
      unitsPerPack: 60,
    });
    expect(
      previewSaleLine({
        option: loose!,
        quantity: 3,
        printedMrpMinor: 6000,
        unitsPerPack: 60,
        availableUnits: 60,
      })
    ).toMatchObject({ canonicalUnits: 3, unitPriceMinor: 100, grossMinor: 300 });
  });

  it('rejects a non-positive conversion', () => {
    expect(() =>
      lotSaleUnitOptions({ packLevelId: 'box', levelLabel: 'BOX', unitsPerPack: 0 })
    ).toThrowError(PharmacyMedicineError);
  });
});

describe('looseSaleUnitOption (F5 / sell loose)', () => {
  it('picks the UNIT option when one is offered', () => {
    const options = saleUnitOptions({
      packLevels: THREE_LEVEL,
      rootPackLevelId: 'box',
      unitsPerPack: 100,
    });
    expect(looseSaleUnitOption(options)).toMatchObject({ kind: 'UNIT', packLevelId: 'unit' });
  });

  it('picks the one-unit option of a lot received at the base level', () => {
    const options = saleUnitOptions({
      packLevels: THREE_LEVEL,
      rootPackLevelId: 'unit',
      unitsPerPack: 1,
    });
    expect(looseSaleUnitOption(options)).toMatchObject({ packLevelId: 'unit' });
  });

  it('finds a loose unit for a standalone pack', () => {
    const pack = { id: 'flat', level: 'STRIP', parentPackLevelId: null, unitsPerParent: 10 };
    expect(
      looseSaleUnitOption(
        saleUnitOptions({ packLevels: [pack], rootPackLevelId: 'flat', unitsPerPack: 10 })
      )
    ).toMatchObject({ kind: 'UNIT', canonicalUnitsPerSaleUnit: 1 });
  });

  it('returns null when nothing sells one canonical unit', () => {
    expect(looseSaleUnitOption([])).toBeNull();
    expect(
      looseSaleUnitOption([
        { kind: 'PACK', packLevelId: 'p', levelLabel: 'BOX', canonicalUnitsPerSaleUnit: 10 },
      ])
    ).toBeNull();
  });
});

/**
 * DEV-830 (security scan F05): the server derives a line's multiplier from the stored pack
 * setup. Every unit the counter offers must be one the server derives, and a pack must
 * never be derivable as a single unit.
 */
describe('packLevelCanonicalUnits (DEV-830 server-derived multiplier)', () => {
  const at = new Date('2026-11-15T00:00:00.000Z');
  const derive =
    (packLevels: Parameters<typeof packLevelCanonicalUnits>[0]['packLevels']) =>
    (packLevelId: string) =>
      packLevelCanonicalUnits({ packLevels, packLevelId, at });

  it('derives each level of a hierarchy, never one unit for a pack', () => {
    const units = derive(THREE_LEVEL);
    expect(units('box')).toEqual([100]);
    expect(units('strip')).toEqual([10]);
    expect(units('unit')).toEqual([1]);
    expect(derive(TWO_LEVEL)('bottle')).toEqual([30]);
  });

  it('counts a standalone pack in its own canonical units', () => {
    expect(
      derive([{ id: 'pack', level: 'PACK', parentPackLevelId: null, unitsPerParent: 10 }])('pack')
    ).toEqual([10]);
  });

  it('offers nothing for a level outside the setup', () => {
    expect(derive(THREE_LEVEL)('elsewhere')).toEqual([]);
  });

  it('derives every unit the counter offers, including a revised setup', () => {
    const revised = [
      {
        id: 'box',
        level: 'BOX',
        parentPackLevelId: null,
        unitsPerParent: 1,
        versionGroupId: 'g-box',
      },
      {
        id: 'strip-v1',
        level: 'STRIP',
        parentPackLevelId: 'box',
        unitsPerParent: 5,
        versionGroupId: 'g-strip',
        effectiveFrom: new Date('2025-01-01T00:00:00.000Z'),
        effectiveTo: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        id: 'strip-v2',
        level: 'STRIP',
        parentPackLevelId: 'box',
        unitsPerParent: 10,
        versionGroupId: 'g-strip',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      },
      {
        id: 'unit',
        level: 'UNIT',
        parentPackLevelId: 'strip-v1',
        unitsPerParent: 10,
        versionGroupId: 'g-unit',
      },
    ];
    for (const [packLevels, lotPackLevelId] of [
      [THREE_LEVEL, 'box'],
      [TWO_LEVEL, 'bottle'],
      [revised, 'box'],
    ] as const) {
      const { saleUnits } = resolveCounterSaleUnits({
        packLevels,
        lotPackLevelId,
        lotPackLevelLabel: null,
        lotUnitsPerPack: lotPackLevelId === 'bottle' ? 30 : 100,
        dosageForm: 'Tablet',
        at,
      });
      expect(saleUnits.length).toBeGreaterThan(0);
      for (const option of saleUnits)
        expect(derive(packLevels)(option.packLevelId)).toContain(option.canonicalUnitsPerSaleUnit);
    }
  });
});

describe('DEV-705 legacy box sale units', () => {
  const input = {
    packLevels: [{ id: 'legacy-box', level: 'BOX', parentPackLevelId: null, unitsPerParent: 100 }],
    lotPackLevelId: 'legacy-box',
    lotPackLevelLabel: 'BOX',
    lotUnitsPerPack: 100,
    dosageForm: 'Tablet',
    presentation: '10x10',
    at: new Date('2026-01-01'),
  };
  it('offers a priced strip and loose tablet without changing a legacy receiving pack', () => {
    const { saleUnits } = resolveCounterSaleUnits(input);
    expect(saleUnits.map((unit) => [unit.kind, unit.canonicalUnitsPerSaleUnit])).toEqual([
      ['PACK', 100],
      ['STRIP', 10],
      ['UNIT', 1],
    ]);
    expect(
      saleUnits.map(
        (option) =>
          previewSaleLine({
            option,
            quantity: 1,
            printedMrpMinor: 25000,
            unitsPerPack: 100,
            availableUnits: 113,
          }).unitPriceMinor
      )
    ).toEqual([25000, 2500, 250]);
    expect(input.packLevels[0]!.unitsPerParent).toBe(100);
  });
  it.each(['100 tablets', '5x2x10', '1x10x10', '10x10 ml vials', 'Carton 10x10', '2x10'])(
    'does not invent a strip for %s',
    (presentation) => {
      expect(
        resolveCounterSaleUnits({ ...input, presentation }).saleUnits.map((u) => u.kind)
      ).toEqual(['PACK', 'UNIT']);
    }
  );
  it('does not infer strips for non-tablet containers or incompatible FEFO lots', () => {
    expect(
      resolveCounterSaleUnits({ ...input, dosageForm: 'Injection' }).saleUnits.map((u) => u.kind)
    ).toEqual(['PACK', 'UNIT']);
    expect(
      resolveCounterSaleUnits({ ...input, otherLotUnitsPerPack: [15] }).saleUnits.some(
        (u) => u.kind === 'STRIP'
      )
    ).toBe(false);
  });
});

describe('DEV-705 manual default sale unit', () => {
  const pack = {
    kind: 'PACK',
    packLevelId: 'box',
    levelLabel: 'BOX',
    canonicalUnitsPerSaleUnit: 100,
  } as const;
  const strip = {
    kind: 'STRIP',
    packLevelId: 'box',
    levelLabel: 'STRIP',
    canonicalUnitsPerSaleUnit: 10,
  } as const;
  const unit = {
    kind: 'UNIT',
    packLevelId: 'box',
    levelLabel: 'UNIT',
    canonicalUnitsPerSaleUnit: 1,
  } as const;
  it('starts tablets and capsules on one loose unit', () => {
    expect(preferredSaleUnitOption([pack, strip, unit], 'Tablet')).toBe(unit);
    expect(preferredSaleUnitOption([pack, strip, unit], 'Capsule')).toBe(unit);
  });
  it('falls back to the strip, then the largest unit, when no loose tablet is sellable', () => {
    expect(preferredSaleUnitOption([pack, strip], 'Tablet')).toBe(strip);
    expect(preferredSaleUnitOption([pack], 'Tablet')).toBe(pack);
  });
  it('keeps the largest unit for other dosage forms', () => {
    expect(preferredSaleUnitOption([pack, unit], 'Syrup')).toBe(pack);
    expect(preferredSaleUnitOption([], 'Tablet')).toBeNull();
  });
  it('labels units in shop words', () => {
    expect([pack, strip, unit].map((option) => saleUnitLabel(option, 'Tablet'))).toEqual([
      'Box of 100',
      'Strip of 10',
      'Tablet',
    ]);
  });
});
