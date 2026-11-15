/**
 * DEV-77 — a supplier claim recovers the goods, not the delivery freight that
 * now sits inside a lot's landed unit cost.
 */
import { describe, expect, it } from 'vitest';

import { supplierClaimSplit } from './finance-postings';

describe('DEV-77 — supplier claim freight split', () => {
  it('claims the whole cost of a lot that carried no freight', () => {
    expect(
      supplierClaimSplit({
        unitCostMinor: 833,
        units: 12,
        allocatedFreightMinor: 0,
        arrivedUnits: 120,
      })
    ).toEqual({ claimableMinor: 9_996, freightMinor: 0 });
  });

  it('claims the whole cost of a lot with no receipt line (opening stock)', () => {
    expect(
      supplierClaimSplit({
        unitCostMinor: 500,
        units: 3,
        allocatedFreightMinor: 0,
        arrivedUnits: 0,
      })
    ).toEqual({ claimableMinor: 1_500, freightMinor: 0 });
  });

  it('expenses the freight share of the returned units instead of claiming it', () => {
    // 100_000 invoice + 20_000 freight over 120 units = 1_000 per unit, of
    // which 167 (20_000 / 120, half-up) is freight.
    const split = supplierClaimSplit({
      unitCostMinor: 1_000,
      units: 12,
      allocatedFreightMinor: 20_000,
      arrivedUnits: 120,
    });
    expect(split).toEqual({ claimableMinor: 9_996, freightMinor: 2_004 });
    expect(split.claimableMinor + split.freightMinor).toBe(12_000);
  });

  it('never splits out more freight than the unit cost holds', () => {
    // An all-bonus lot whose whole cost is freight.
    expect(
      supplierClaimSplit({
        unitCostMinor: 10,
        units: 5,
        allocatedFreightMinor: 500,
        arrivedUnits: 50,
      })
    ).toEqual({ claimableMinor: 0, freightMinor: 50 });
  });
});
