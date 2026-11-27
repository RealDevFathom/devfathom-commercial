import { describe, expect, it } from 'vitest';

import { PharmacyInventoryError } from './inventory';
import {
  planQuarantineRelease,
  QUARANTINE_SAFETY_RELEASE_REFUSED,
  splitQuarantineHold,
} from './quarantine-holds';

describe('DEV-1052 splitQuarantineHold', () => {
  it.each([
    [
      'recorded owners that add up',
      { manualUnits: 10, safetyRecorded: 6, inventoryRecorded: 4 },
      6,
      4,
    ],
    ['a hold nobody recorded', { manualUnits: 10, safetyRecorded: 0, inventoryRecorded: 0 }, 10, 0],
    [
      'unowned units beside an inventory hold',
      { manualUnits: 10, safetyRecorded: 0, inventoryRecorded: 4 },
      6,
      4,
    ],
    // Units left quarantine without a release: inventory's share shrinks first.
    [
      'a removal the entries have not seen',
      { manualUnits: 6, safetyRecorded: 6, inventoryRecorded: 4 },
      6,
      0,
    ],
    [
      'inventory entries larger than what is held',
      { manualUnits: 3, safetyRecorded: 0, inventoryRecorded: 9 },
      0,
      3,
    ],
    ['nothing held', { manualUnits: 0, safetyRecorded: 5, inventoryRecorded: 5 }, 0, 0],
    ['corrupt negative sums', { manualUnits: 5, safetyRecorded: -3, inventoryRecorded: -2 }, 5, 0],
  ])('fails closed for %s', (_label, input, safetyUnits, inventoryUnits) => {
    expect(splitQuarantineHold(input)).toEqual({ safetyUnits, inventoryUnits });
  });
});

describe('DEV-1052 planQuarantineRelease', () => {
  const hold = { safetyUnits: 6, inventoryUnits: 4 };
  const refused = (units: number, rights: { safety: boolean; inventory: boolean }) => {
    try {
      planQuarantineRelease(hold, units, rights);
    } catch (error) {
      expect(error).toBeInstanceOf(PharmacyInventoryError);
      expect((error as PharmacyInventoryError).reason).toBe('QUARANTINE_RELEASE_REFUSED');
      return (error as PharmacyInventoryError).userMessage;
    }
    throw new Error('the release was planned');
  };

  it('lets inventory take inventory units only, never one more', () => {
    const rights = { safety: false, inventory: true };
    expect(planQuarantineRelease(hold, 4, rights)).toEqual({ safetyUnits: 0, inventoryUnits: 4 });
    expect(refused(5, rights)).toContain('Only 4 of these units');
    expect(refused(10, rights)).toContain('Only 4 of these units');
    expect(
      (() => {
        try {
          planQuarantineRelease({ safetyUnits: 6, inventoryUnits: 0 }, 1, rights);
        } catch (error) {
          return (error as PharmacyInventoryError).userMessage;
        }
      })()
    ).toBe(QUARANTINE_SAFETY_RELEASE_REFUSED);
  });

  it('lets safety take safety units only', () => {
    const rights = { safety: true, inventory: false };
    expect(planQuarantineRelease(hold, 6, rights)).toEqual({ safetyUnits: 6, inventoryUnits: 0 });
    expect(refused(7, rights)).toContain('Only 6 of these units are a safety hold');
  });

  it('draws on inventory holds first for someone holding both permissions', () => {
    const rights = { safety: true, inventory: true };
    expect(planQuarantineRelease(hold, 5, rights)).toEqual({ safetyUnits: 1, inventoryUnits: 4 });
    expect(planQuarantineRelease(hold, 10, rights)).toEqual({ safetyUnits: 6, inventoryUnits: 4 });
  });

  it('releases nothing for someone holding neither permission', () => {
    expect(refused(1, { safety: false, inventory: false })).toBe(
      'You do not have permission to release held stock.'
    );
  });
});
