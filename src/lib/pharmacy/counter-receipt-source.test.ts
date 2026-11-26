import { describe, expect, it, vi } from 'vitest';
import { readCounterReceipt } from './counter';

function fixture(actorId: string | null = 'settling-cashier') {
  const sale = {
    id: 'sale-a',
    createdByUserId: 'bill-creator',
    receiptNumber: 1,
    completedAt: new Date('2026-11-01T20:12:00Z'),
    businessDate: new Date('2026-11-01'),
    lines: [
      {
        id: 'line-a',
        saleUnit: 'UNIT',
        quantity: 1,
        canonicalUnits: 1,
        unitPriceMinor: 100,
        discountMinor: 0,
        grossMinor: 100,
        allocations: [],
      },
    ],
    tenders: [
      {
        id: 'tender-a',
        type: 'CASH',
        amountMinor: 100,
        cashReceivedMinor: 100,
        changeGivenMinor: 0,
      },
    ],
  };
  const db = {
    pharmacySale: { findFirst: vi.fn(async () => sale) },
    pharmacySaleEvent: { findMany: vi.fn(async () => [{ payload: {}, actorId }]) },
    user: { findFirst: vi.fn(async (): Promise<{ name: string } | null> => ({ name: 'Ayesha' })) },
  };
  return {
    db,
    read: () =>
      readCounterReceipt(
        db as never,
        { organizationId: 'org-a', branchId: 'branch-a' },
        'sale-a',
        { name: 'Synthetic pharmacy', currency: 'PKR' }
      ),
  };
}
describe('DEV-636 receipt cashier attribution', () => {
  it('uses the completion actor rather than the bill creator or current reader', async () => {
    const f = fixture();
    await expect(f.read()).resolves.toMatchObject({ cashierName: 'Ayesha', receiptNumber: 1 });
    expect(f.db.user.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'settling-cashier', organizationId: 'org-a' },
      select: { name: true },
    });
    expect(f.db.pharmacySale.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sale-a', organizationId: 'org-a', branchId: 'branch-a' },
      })
    );
  });
  it('does not invent a cashier for historical data without a completion actor', async () => {
    const f = fixture(null);
    await expect(f.read()).resolves.toMatchObject({ cashierName: null });
    expect(f.db.user.findFirst).not.toHaveBeenCalled();
  });
  it('withholds an unresolved or foreign completion actor name', async () => {
    const f = fixture('foreign-user');
    f.db.user.findFirst.mockResolvedValue(null);
    await expect(f.read()).resolves.toMatchObject({ cashierName: null });
    expect(f.db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-user', organizationId: 'org-a' },
      select: { name: true },
    });
  });
});

describe('#708 cash memo facts on reprint', () => {
  function snapshotFixture(extra: {
    buyerName?: string;
    manufacturer?: string;
    cashMemoIdentity?: {
      ntn: null;
      strn: null;
      provinceCode: string;
      licenceNumber: string;
    } | null;
  }) {
    const completedAt = new Date('2026-11-14T09:30:00.000Z');
    const sale = {
      id: 'sale-a',
      receiptNumber: 5,
      receiptDeviceId: 'counter-a',
      completedAt,
      businessDate: new Date('2026-11-14T00:00:00.000Z'),
      lines: [
        {
          id: 'line-a',
          medicineId: 'med-a',
          presentationId: 'pres-a',
          saleUnit: 'UNIT',
          quantity: 2,
          canonicalUnits: 2,
          unitPriceMinor: 100,
          discountMinor: 0,
          grossMinor: 200,
          allocations: [
            { id: 'al-a', inventoryLotId: 'lot-a', canonicalUnits: 2, grossMinor: 200 },
          ],
        },
      ],
      tenders: [],
    };
    const payload = {
      receiptIdentitySnapshotVersion: 1,
      saleId: 'sale-a',
      receiptNumber: 5,
      deviceId: 'counter-a',
      businessDate: '2026-11-14',
      issuedAt: completedAt.toISOString(),
      ...(extra.buyerName ? { buyerName: extra.buyerName } : {}),
      ...(extra.cashMemoIdentity !== undefined ? { cashMemoIdentity: extra.cashMemoIdentity } : {}),
      lines: [
        {
          saleLineId: 'line-a',
          medicineId: 'med-a',
          presentationId: 'pres-a',
          medicineName: 'Paracetamol',
          strength: '500 mg',
          presentation: 'Tablet',
          ...(extra.manufacturer ? { manufacturer: extra.manufacturer } : {}),
          allocations: [
            {
              allocationId: 'al-a',
              inventoryLotId: 'lot-a',
              batchNumber: 'B-001',
              expiresAt: '2027-06-30T00:00:00.000Z',
              canonicalUnits: 2,
            },
          ],
        },
      ],
    };
    const db = {
      pharmacySale: { findFirst: vi.fn(async () => sale) },
      pharmacySaleEvent: { findMany: vi.fn(async () => [{ payload, actorId: null }]) },
      pharmacyRegisteredDevice: { findFirst: vi.fn(async () => null) },
      user: { findFirst: vi.fn() },
    };
    return readCounterReceipt(
      db as never,
      { organizationId: 'org-a', branchId: 'branch-a' },
      'sale-a',
      { name: 'Synthetic pharmacy', currency: 'PKR' }
    );
  }

  it('reprints the buyer and manufacturer recorded when the sale completed', async () => {
    const receipt = await snapshotFixture({
      buyerName: 'Ayesha Khan',
      manufacturer: 'GSK Pakistan',
    });
    expect(receipt.buyerName).toBe('Ayesha Khan');
    expect(receipt.lines[0]).toMatchObject({
      identityStatus: 'ISSUED',
      manufacturer: 'GSK Pakistan',
    });
  });

  it('reads older snapshots without the facts as unrecorded, never invented', async () => {
    const receipt = await snapshotFixture({});
    expect(receipt.buyerName).toBeNull();
    expect(receipt.lines[0]).toMatchObject({ identityStatus: 'ISSUED', manufacturer: null });
  });

  it('reads the issued regulatory facts and explicit Punjab mode from the immutable snapshot', async () => {
    const cashMemoIdentity = {
      ntn: null,
      strn: null,
      provinceCode: 'PK-SD',
      licenceNumber: 'ISSUED-SYNTHETIC-LICENCE',
    } as const;
    expect((await snapshotFixture({ cashMemoIdentity })).cashMemoIdentity).toEqual(
      cashMemoIdentity
    );
    expect((await snapshotFixture({ cashMemoIdentity: null })).cashMemoIdentity).toBeNull();
  });
});

it('uses recorded branch and counter references when an old sale never froze their display names', async () => {
  const f = fixture();
  const result = await readCounterReceipt(
    f.db as never,
    { organizationId: 'org-a', branchId: 'branch-a' },
    'sale-a',
    { name: 'Renamed branch', currency: 'PKR', useRecordedLocation: true }
  );
  expect(result.branchName).toBe('Branch branch-a');
  expect(result.branchName).not.toBe('Renamed branch');
});
