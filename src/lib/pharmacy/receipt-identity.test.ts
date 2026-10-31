import { describe, expect, it } from 'vitest';
import { readReceiptIdentity, validateReceiptIdentity } from './receipt-identity';

const date = new Date('2026-09-05T00:00:00.000Z');
const allocations = [
  { id: 'a2', inventoryLotId: 'lot2', canonicalUnits: 3 },
  { id: 'a1', inventoryLotId: 'lot1', canonicalUnits: 7 },
];
const sale = {
  id: 'sale',
  receiptNumber: 1,
  receiptDeviceId: 'device',
  businessDate: date,
  completedAt: date,
  lines: [
    {
      id: 'line',
      medicineId: 'medicine',
      presentationId: 'presentation',
      canonicalUnits: 10,
      allocations,
    },
  ],
};
const snapshot = {
  receiptIdentitySnapshotVersion: 1,
  saleId: sale.id,
  receiptNumber: 1,
  deviceId: 'device',
  businessDate: '2026-09-05',
  issuedAt: date.toISOString(),
  lines: [
    {
      saleLineId: 'line',
      medicineId: 'medicine',
      presentationId: 'presentation',
      medicineName: 'Issued medicine',
      strength: '500 mg',
      presentation: 'Tablet',
      allocations: allocations.map((a) => ({
        allocationId: a.id,
        inventoryLotId: a.inventoryLotId,
        canonicalUnits: a.canonicalUnits,
        batchNumber: a.id,
        expiresAt: '2027-01-01T00:00:00.000Z',
      })),
    },
  ],
};

describe('issued receipt identity correspondence', () => {
  it('preserves both actual quantities independently of allocation ID order', () => {
    expect(validateReceiptIdentity(snapshot, sale)).toEqual(snapshot);
  });
  it('preserves frozen cash memo facts, including a non-Sindh null, without breaking legacy snapshots', () => {
    for (const cashMemo of [
      null,
      {
        template: 'SINDH_CASH_MEMO',
        licenceNumber: 'DL-ISSUED',
        licenceValidFrom: '2026-01-01T00:00:00.000Z',
        licenceValidTo: '2027-12-31T00:00:00.000Z',
        pharmacistRegistration: 'QP-ISSUED',
      },
    ]) {
      expect(validateReceiptIdentity({ ...snapshot, cashMemo }, sale).cashMemo).toEqual(cashMemo);
    }
    expect(validateReceiptIdentity(snapshot, sale).cashMemo).toBeUndefined();
    expect(() =>
      validateReceiptIdentity({ ...snapshot, cashMemo: { template: 'SINDH_CASH_MEMO' } }, sale)
    ).toThrow('INVALID_RECEIPT_IDENTITY');
  });
  it('marks missing historic evidence unavailable, ignoring status-only completion', () => {
    expect(readReceiptIdentity([{ payload: null }, { payload: {} }], sale)).toBeNull();
  });
  it('refuses multiple numbered issuance snapshots', () => {
    expect(() => readReceiptIdentity([{ payload: snapshot }, { payload: snapshot }], sale)).toThrow(
      'INVALID_RECEIPT_IDENTITY'
    );
  });
  it.each([
    [
      'unknown version',
      (s: typeof snapshot) => {
        s.receiptIdentitySnapshotVersion = 2;
      },
    ],
    [
      'wrong sale',
      (s: typeof snapshot) => {
        s.saleId = 'other';
      },
    ],
    [
      'wrong device',
      (s: typeof snapshot) => {
        s.deviceId = 'other';
      },
    ],
    [
      'wrong receipt',
      (s: typeof snapshot) => {
        s.receiptNumber = 2;
      },
    ],
    [
      'wrong date',
      (s: typeof snapshot) => {
        s.businessDate = '2026-09-06';
      },
    ],
    [
      'wrong issued time',
      (s: typeof snapshot) => {
        s.issuedAt = '2026-09-06T00:00:00.000Z';
      },
    ],
    [
      'missing line',
      (s: typeof snapshot) => {
        s.lines = [];
      },
    ],
    [
      'duplicate line',
      (s: typeof snapshot) => {
        s.lines.push(s.lines[0]!);
      },
    ],
    [
      'wrong medicine',
      (s: typeof snapshot) => {
        s.lines[0]!.medicineId = 'other';
      },
    ],
    [
      'wrong presentation',
      (s: typeof snapshot) => {
        s.lines[0]!.presentationId = 'other';
      },
    ],
    [
      'missing allocation',
      (s: typeof snapshot) => {
        s.lines[0]!.allocations.pop();
      },
    ],
    [
      'duplicate allocation',
      (s: typeof snapshot) => {
        s.lines[0]!.allocations[1] = s.lines[0]!.allocations[0]!;
      },
    ],
    [
      'wrong lot',
      (s: typeof snapshot) => {
        s.lines[0]!.allocations[0]!.inventoryLotId = 'other';
      },
    ],
    [
      'wrong quantity',
      (s: typeof snapshot) => {
        s.lines[0]!.allocations[0]!.canonicalUnits = 10;
      },
    ],
    [
      'missing name',
      (s: typeof snapshot) => {
        s.lines[0]!.medicineName = '';
      },
    ],
  ])('fails closed for %s', (_, mutate) => {
    const invalid = structuredClone(snapshot);
    mutate(invalid);
    expect(() => readReceiptIdentity([{ payload: invalid }], sale)).toThrow(
      'INVALID_RECEIPT_IDENTITY'
    );
  });
  it('refuses allocation totals inconsistent with the persisted line', () => {
    expect(() =>
      validateReceiptIdentity(snapshot, {
        ...sale,
        lines: [{ ...sale.lines[0]!, canonicalUnits: 11 }],
      })
    ).toThrow('INVALID_RECEIPT_IDENTITY');
  });
});
