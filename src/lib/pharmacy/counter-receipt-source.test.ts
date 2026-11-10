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
