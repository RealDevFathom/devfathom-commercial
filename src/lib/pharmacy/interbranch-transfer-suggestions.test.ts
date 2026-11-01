import { describe, expect, it } from 'vitest';
import {
  suggestInterbranchTransfers,
  type TransferSuggestionPolicy,
  type TransferSuggestionPosition,
} from './interbranch-transfer-suggestions';

const policy: TransferSuggestionPolicy = {
  shortageCoverDays: 3,
  targetCoverDays: 7,
  surplusReserveDays: 10,
  minimumShelfLifeDays: 2,
};
const asOf = new Date('2026-10-29T00:00:00.000Z');

describe('growth #746 transfer suggestions', () => {
  it('matches a surplus/short fixture and chooses eligible stock FEFO', () => {
    const result = suggestInterbranchTransfers(
      [
        {
          branchId: 'surplus',
          medicineId: 'item',
          destinationStockLocationId: 'unused',
          forecastDailyUnits: 2,
          lots: [
            {
              lotId: 'later',
              stockLocationId: 'shelf',
              availableUnits: 20,
              expiresAt: new Date('2027-03-01'),
            },
            {
              lotId: 'first',
              stockLocationId: 'shelf',
              availableUnits: 10,
              expiresAt: new Date('2027-01-01'),
            },
          ],
        },
        {
          branchId: 'short',
          medicineId: 'item',
          destinationStockLocationId: 'dispensary',
          forecastDailyUnits: 4,
          lots: [
            {
              lotId: 'own',
              stockLocationId: 'dispensary',
              availableUnits: 4,
              expiresAt: new Date('2027-04-01'),
            },
          ],
        },
      ],
      policy,
      asOf
    );

    expect(result).toEqual([
      expect.objectContaining({
        fromBranchId: 'surplus',
        toBranchId: 'short',
        destinationCoverDays: 1,
        quantityUnits: 10,
        lines: [expect.objectContaining({ sourceLotId: 'first', quantityUnits: 10 })],
      }),
    ]);
  });

  it('does not suggest a lot the destination cannot consume before the configured expiry buffer', () => {
    const result = suggestInterbranchTransfers(
      [
        {
          branchId: 'surplus',
          medicineId: 'item',
          destinationStockLocationId: 'unused',
          forecastDailyUnits: 0,
          lots: [
            {
              lotId: 'expiring',
              stockLocationId: 'shelf',
              availableUnits: 50,
              expiresAt: new Date('2026-10-30'),
            },
          ],
        },
        {
          branchId: 'short',
          medicineId: 'item',
          destinationStockLocationId: 'store',
          forecastDailyUnits: 1,
          lots: [],
        },
      ],
      policy,
      asOf
    );
    expect(result).toEqual([]);
  });

  it('falls back to a later surplus branch when the first source has no expiry-eligible stock', () => {
    const result = suggestInterbranchTransfers(
      [
        {
          branchId: 'a-expiring',
          medicineId: 'item',
          destinationStockLocationId: 'unused',
          forecastDailyUnits: 0,
          lots: [
            {
              lotId: 'expiring',
              stockLocationId: 'shelf',
              availableUnits: 50,
              expiresAt: new Date('2026-10-30'),
            },
          ],
        },
        {
          branchId: 'b-eligible',
          medicineId: 'item',
          destinationStockLocationId: 'unused',
          forecastDailyUnits: 0,
          lots: [
            {
              lotId: 'eligible',
              stockLocationId: 'shelf',
              availableUnits: 50,
              expiresAt: new Date('2027-10-30'),
            },
          ],
        },
        {
          branchId: 'short',
          medicineId: 'item',
          destinationStockLocationId: 'store',
          forecastDailyUnits: 1,
          lots: [],
        },
      ],
      policy,
      asOf
    );

    expect(result).toEqual([
      expect.objectContaining({
        fromBranchId: 'b-eligible',
        toBranchId: 'short',
        quantityUnits: 7,
      }),
    ]);
  });

  it.each([
    ['asOf', [], new Date('invalid')],
    [
      'forecastDailyUnits',
      [
        {
          branchId: 'branch',
          medicineId: 'item',
          destinationStockLocationId: 'store',
          forecastDailyUnits: Number.NaN,
          lots: [],
        },
      ],
      asOf,
    ],
    [
      'availableUnits',
      [
        {
          branchId: 'branch',
          medicineId: 'item',
          destinationStockLocationId: 'store',
          forecastDailyUnits: 1,
          lots: [
            {
              lotId: 'lot',
              stockLocationId: 'store',
              availableUnits: -1,
              expiresAt: new Date('2027-01-01'),
            },
          ],
        },
      ],
      asOf,
    ],
    [
      'expiresAt',
      [
        {
          branchId: 'branch',
          medicineId: 'item',
          destinationStockLocationId: 'store',
          forecastDailyUnits: 1,
          lots: [
            {
              lotId: 'lot',
              stockLocationId: 'store',
              availableUnits: 1,
              expiresAt: new Date('invalid'),
            },
          ],
        },
      ],
      asOf,
    ],
  ])('rejects malformed planning input: %s', (field, positions, date) => {
    expect(() => suggestInterbranchTransfers(positions, policy, date)).toThrow(
      `INVALID_PLANNING_INPUT:${field}`
    );
  });

  it('rejects missing or inconsistent tenant policy instead of using research figures as defaults', () => {
    expect(() => suggestInterbranchTransfers([], { ...policy, targetCoverDays: 2 }, asOf)).toThrow(
      'INVALID_POLICY:targetCoverDays'
    );
  });

  it.each(Object.keys(policy) as Array<keyof TransferSuggestionPolicy>)(
    'rejects an omitted policy field: %s',
    (field) => {
      const incomplete = { ...policy };
      Reflect.deleteProperty(incomplete, field);
      expect(() => suggestInterbranchTransfers([], incomplete, asOf)).toThrow(
        `INVALID_POLICY:${field}`
      );
    }
  );

  const lot = (lotId: string, availableUnits: number, days: number) => ({
    lotId,
    stockLocationId: 'shelf',
    availableUnits,
    expiresAt: new Date(asOf.getTime() + days * 86_400_000),
  });
  const source: TransferSuggestionPosition = {
    branchId: 'source',
    medicineId: 'item',
    destinationStockLocationId: 'unused',
    forecastDailyUnits: 0,
    lots: [],
  };
  const destination: TransferSuggestionPosition = {
    ...source,
    branchId: 'short',
    destinationStockLocationId: 'store',
    forecastDailyUnits: 1,
  };

  it.each([
    [5, 3],
    [7, 5],
  ])('shares expiry consumption capacity across lots expiring on day %i', (days, expected) => {
    const result = suggestInterbranchTransfers(
      [{ ...source, lots: [lot('first', 2, 5), lot('second', 10, days)] }, destination],
      policy,
      asOf
    );
    expect(result[0].quantityUnits).toBe(expected);
    expect(result[0].lines.map((line) => line.quantityUnits)).toEqual([2, expected - 2]);
  });

  it.each([
    [4, 1],
    [10, 3],
  ])('accounts for destination stock in FEFO order when its expiry is day %i', (days, expected) => {
    const result = suggestInterbranchTransfers(
      [
        { ...source, lots: [lot('incoming', 10, 5)] },
        { ...destination, lots: [lot('own', 2, days)] },
      ],
      policy,
      asOf
    );
    expect(result[0].quantityUnits).toBe(expected);
  });

  it('excludes expired stock from destination coverage', () => {
    const result = suggestInterbranchTransfers(
      [
        { ...source, lots: [lot('incoming', 10, 30)] },
        { ...destination, lots: [lot('expired', 100, 0)] },
      ],
      policy,
      asOf
    );
    expect(result).toEqual([
      expect.objectContaining({ destinationCoverDays: 0, quantityUnits: 7 }),
    ]);
  });

  it('excludes expired source stock when retaining the source reserve', () => {
    const result = suggestInterbranchTransfers(
      [
        {
          ...source,
          forecastDailyUnits: 1,
          lots: [lot('expired', 100, -1), lot('usable', 12, 30)],
        },
        destination,
      ],
      policy,
      asOf
    );
    expect(result).toEqual([expect.objectContaining({ sourceCoverDays: 12, quantityUnits: 2 })]);
  });
});
