/**
 * DEV-77 — landed cost per lot: bonus units, freight and non-recoverable tax
 * spread across every unit that arrived on the receipt.
 */
import { describe, expect, it } from 'vitest';

import { PharmacyReceivingError, receiptLandedCosts, receiptLineUnitCostMinor } from './receiving';

const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof PharmacyReceivingError) return error.reason;
    throw error;
  }
  return null;
};

describe('DEV-77 — landed cost per lot', () => {
  it('costs a 10+1 bonus lot at paid/11 per unit', () => {
    // Ten packs paid at 1,100.00, one pack free, one canonical unit per pack.
    const [lot] = receiptLandedCosts({
      lines: [
        {
          receivedPacks: 10,
          bonusPacks: 1,
          canonicalUnitsPerPack: 1,
          invoicedPricePerPackMinor: 110_000,
        },
      ],
    });
    expect(lot).toEqual({ allocatedFreightMinor: 0, unitCostMinor: 1_100_000 / 11 });
  });

  it('spreads freight and a non-creditable tax over paid and bonus units alike', () => {
    // 10 packs × 1,000.00 + 17% non-creditable tax = 11,700.00, plus 300.00
    // freight = 12,000.00, over (10 + 2) packs × 10 units = 120 units.
    const [lot] = receiptLandedCosts({
      freightMinor: 30_000,
      lines: [
        {
          receivedPacks: 10,
          bonusPacks: 2,
          canonicalUnitsPerPack: 10,
          invoicedPricePerPackMinor: 100_000,
          taxBps: 1_700,
        },
      ],
    });
    expect(lot).toEqual({ allocatedFreightMinor: 30_000, unitCostMinor: 10_000 });
  });

  it('leaves a recoverable (creditable) tax out of the landed cost', () => {
    const [lot] = receiptLandedCosts({
      freightMinor: 0,
      lines: [
        {
          receivedPacks: 10,
          bonusPacks: 0,
          canonicalUnitsPerPack: 10,
          invoicedPricePerPackMinor: 10_000,
          taxBps: 1_700,
          taxCreditable: true,
        },
      ],
    });
    expect(lot!.unitCostMinor).toBe(1_000);
  });

  it('allocates receipt freight by line cost, summing to the billed freight exactly', () => {
    const landed = receiptLandedCosts({
      freightMinor: 1_000,
      lines: [
        // 30,000 of cost
        {
          receivedPacks: 3,
          bonusPacks: 0,
          canonicalUnitsPerPack: 1,
          invoicedPricePerPackMinor: 10_000,
        },
        // 60,000 of cost
        {
          receivedPacks: 6,
          bonusPacks: 0,
          canonicalUnitsPerPack: 1,
          invoicedPricePerPackMinor: 10_000,
        },
        // 10,000 of cost
        {
          receivedPacks: 1,
          bonusPacks: 0,
          canonicalUnitsPerPack: 1,
          invoicedPricePerPackMinor: 10_000,
        },
      ],
    });
    expect(landed.map((line) => line.allocatedFreightMinor)).toEqual([300, 600, 100]);
    expect(landed.reduce((sum, line) => sum + line.allocatedFreightMinor, 0)).toBe(1_000);
    expect(landed.map((line) => line.unitCostMinor)).toEqual([10_100, 10_100, 10_100]);
  });

  it('never invents or loses a paisa of freight when the split is uneven', () => {
    const landed = receiptLandedCosts({
      freightMinor: 100,
      lines: [1, 1, 1].map(() => ({
        receivedPacks: 1,
        bonusPacks: 0,
        canonicalUnitsPerPack: 1,
        invoicedPricePerPackMinor: 1_000,
      })),
    });
    expect(landed.map((line) => line.allocatedFreightMinor)).toEqual([34, 33, 33]);
  });

  it('costs a receipt with no freight exactly as the per-line cost always did', () => {
    const terms = {
      receivedPacks: 7,
      bonusPacks: 3,
      canonicalUnitsPerPack: 12,
      invoicedPricePerPackMinor: 45_678,
      discountBps: 250,
      taxBps: 1_800,
    };
    const [lot] = receiptLandedCosts({ lines: [terms] });
    expect(lot!.unitCostMinor).toBe(receiptLineUnitCostMinor(terms));
    expect(lot!.allocatedFreightMinor).toBe(0);
  });

  it('gives an all-bonus delivery only the freight it carried', () => {
    const [lot] = receiptLandedCosts({
      freightMinor: 500,
      lines: [
        {
          receivedPacks: 0,
          bonusPacks: 5,
          canonicalUnitsPerPack: 10,
          invoicedPricePerPackMinor: 9_999,
        },
      ],
    });
    expect(lot).toEqual({ allocatedFreightMinor: 500, unitCostMinor: 10 });
  });

  it('refuses negative, fractional or unsafe freight', () => {
    const line = {
      receivedPacks: 1,
      bonusPacks: 0,
      canonicalUnitsPerPack: 1,
      invoicedPricePerPackMinor: 100,
    };
    for (const freightMinor of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(reasonOf(() => receiptLandedCosts({ freightMinor, lines: [line] }))).toBe(
        'INVALID_MONEY'
      );
    }
    expect(reasonOf(() => receiptLineUnitCostMinor({ ...line, allocatedChargeMinor: -1 }))).toBe(
      'INVALID_MONEY'
    );
  });

  it('refuses a receipt with no lines to carry the freight', () => {
    expect(reasonOf(() => receiptLandedCosts({ freightMinor: 100, lines: [] }))).toBe(
      'INVALID_QUANTITY'
    );
  });
});
