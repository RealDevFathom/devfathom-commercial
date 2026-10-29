import { describe, expect, it } from 'vitest';
import {
  suggestInterbranchTransfers,
  type TransferSuggestionPolicy,
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

  it('rejects missing or inconsistent tenant policy instead of using research figures as defaults', () => {
    expect(() => suggestInterbranchTransfers([], { ...policy, targetCoverDays: 2 }, asOf)).toThrow(
      'INVALID_POLICY:targetCoverDays'
    );
  });
});
