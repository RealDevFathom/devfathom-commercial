import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { DEFAULT_MATERIALITY_THRESHOLD, missingAttributes } from './opening-stock';

/** A line with every required attribute present. */
function completeLine() {
  return {
    sourceRef: 'ABZ-000123',
    manufacturingBatchId: 'batch_1',
    batchNumber: 'B-77',
    expiryDate: new Date('2027-06-01T00:00:00.000Z'),
    expiryPrecision: 'MONTH' as const,
    printedMrpMinor: 25_000,
    unitCostMinor: 18_000,
    stockLocationId: 'loc_1',
    packLevelId: 'pack_1',
    unitsPerPack: 10,
    countedUnits: 40,
  };
}

describe('MIG-03 opening line completeness', () => {
  it('raises no exception when every required attribute is present', () => {
    expect(missingAttributes(completeLine())).toEqual([]);
  });

  it.each([
    ['sourceRef', 'MISSING_SOURCE_REF'],
    ['manufacturingBatchId', 'MISSING_BATCH'],
    ['batchNumber', 'MISSING_BATCH'],
    ['expiryDate', 'MISSING_EXPIRY'],
    ['expiryPrecision', 'MISSING_EXPIRY'],
    ['printedMrpMinor', 'MISSING_MRP'],
    ['unitCostMinor', 'MISSING_COST'],
    ['stockLocationId', 'MISSING_LOCATION'],
    ['packLevelId', 'MISSING_LOCATION'],
    ['unitsPerPack', 'MISSING_LOCATION'],
    ['countedUnits', 'MISSING_COUNT'],
  ] as const)('reports %s missing as %s', (attribute, bucket) => {
    const gaps = missingAttributes({ ...completeLine(), [attribute]: null });
    expect(gaps).toContain(bucket);
  });

  /**
   * MIG-02 acceptance: missing batch/expiry/MRP is never silently defaulted. The
   * pure check is the first of the three guards (service, this, and the CHECK on
   * `pharmacy_opening_stock_lines`).
   */
  it('reports every gap at once rather than stopping at the first', () => {
    const gaps = missingAttributes({
      ...completeLine(),
      batchNumber: null,
      manufacturingBatchId: null,
      expiryDate: null,
      printedMrpMinor: null,
    });
    expect(gaps.sort()).toEqual(['MISSING_BATCH', 'MISSING_EXPIRY', 'MISSING_MRP']);
  });

  it('treats a blank source reference as absent rather than as a value', () => {
    expect(missingAttributes({ ...completeLine(), sourceRef: '   ' })).toEqual([
      'MISSING_SOURCE_REF',
    ]);
  });

  /** A counted zero is a fact about the shelf, not a missing value. */
  it('accepts a counted quantity of zero as a real count', () => {
    expect(missingAttributes({ ...completeLine(), countedUnits: 0 })).toEqual([]);
  });
});

describe('D05 materiality threshold default', () => {
  it('defaults to zero, so every variance is material until the contract sets one', () => {
    expect(DEFAULT_MATERIALITY_THRESHOLD).toEqual({
      thresholdMinor: BigInt(0),
      thresholdUnits: 0,
    });
  });
});
