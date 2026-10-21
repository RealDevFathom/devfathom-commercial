import { describe, expect, it } from 'vitest';

import {
  daysUntilExpiry,
  listSupplierReturnCandidates,
  nearExpiryAlertBand,
  type NearExpiryReturnLot,
} from './near-expiry-alerts';

const AT = new Date('2026-10-21T00:00:00.000Z');
const DAY = 86_400_000;

function lot(overrides: Partial<NearExpiryReturnLot> = {}): NearExpiryReturnLot {
  return {
    lotId: 'lot-a',
    medicineName: 'Panadol',
    batchNumber: 'B-1',
    supplierId: 'supplier-a',
    supplierName: 'Getz Pharma',
    onHandUnits: 10,
    unitCostMinor: 500,
    expiresAt: new Date(AT.getTime() + 20 * DAY),
    returnWindowDays: 30,
    ...overrides,
  };
}

describe('near-expiry alert bands', () => {
  it('alerts at 30, 60 and 90 days and stops at the boundary', () => {
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 30 * DAY), AT)).toBe(30);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 30 * DAY + 1), AT)).toBe(60);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 60 * DAY), AT)).toBe(60);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 60 * DAY + 1), AT)).toBe(90);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 90 * DAY), AT)).toBe(90);
    expect(nearExpiryAlertBand(new Date(AT.getTime() + 90 * DAY + 1), AT)).toBeNull();
    expect(nearExpiryAlertBand(AT, AT)).toBeNull();
    expect(nearExpiryAlertBand(new Date(AT.getTime() - DAY), AT)).toBeNull();
  });

  it('counts a partial day as a whole day remaining', () => {
    expect(daysUntilExpiry(new Date(AT.getTime() + 1), AT)).toBe(1);
    expect(daysUntilExpiry(new Date(AT.getTime() + 30 * DAY), AT)).toBe(30);
  });
});

describe('supplier return list', () => {
  it('keeps near-expiry lots that name a supplier and flags an open return window', () => {
    const rows = listSupplierReturnCandidates(
      [
        lot({
          lotId: 'later',
          expiresAt: new Date(AT.getTime() + 80 * DAY),
          returnWindowDays: 14,
        }),
        lot({ lotId: 'sooner', expiresAt: new Date(AT.getTime() + 10 * DAY) }),
        lot({ lotId: 'unnamed', supplierId: null, supplierName: '  ' }),
        lot({ lotId: 'far', expiresAt: new Date(AT.getTime() + 120 * DAY) }),
        lot({ lotId: 'empty', onHandUnits: 0 }),
      ],
      AT
    );
    expect(rows.map((row) => [row.lotId, row.alertDays, row.returnWindowOpen])).toEqual([
      ['sooner', 30, true],
      ['later', 90, false],
    ]);
    expect(rows[0]!.valueAtRiskMinor).toBe(5_000);
    expect(rows[0]!.daysRemaining).toBe(10);
  });

  it('lists a named supplier even when no return window is recorded', () => {
    const rows = listSupplierReturnCandidates(
      [lot({ supplierId: null, supplierName: 'Local wholesaler', returnWindowDays: null })],
      AT
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.returnWindowOpen).toBe(false);
    expect(rows[0]!.returnWindowDays).toBeNull();
  });
});
