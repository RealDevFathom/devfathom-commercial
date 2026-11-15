import { describe, expect, it, vi } from 'vitest';
import { listLoyaltyCustomers, readLoyaltyHistory } from './customer-loyalty';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
function fixture() {
  return {
    pharmacyBranch: { findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }) },
    pharmacyCustomer: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'customer-a',
        displayName: 'Retail customer',
        phoneLast4: '1234',
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    pharmacyLoyaltyMigration: { findUnique: vi.fn().mockResolvedValue(null) },
    pharmacyLoyaltyProgramVersion: {
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'program-a', mode: 'PERCENT', rewardPoints: 1, spendMinor: 100 }),
    },
    pharmacyLoyaltyPointsEntry: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: 14 } }),
      count: vi.fn().mockResolvedValue(26),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

describe('ordinary loyalty history reads', () => {
  it('scopes every ledger query and bounds page two without paging the balance', async () => {
    const db = fixture();
    const result = await readLoyaltyHistory(db as never, scope, 'customer-a', 2);
    expect(result).toMatchObject({ pointsBalance: 14, page: 2, pageCount: 2, hasNext: false });
    expect(db.pharmacyBranch.findFirst).toHaveBeenCalledWith({
      where: { id: 'branch-a', organizationId: 'org-a', active: true },
      select: { id: true },
    });
    for (const method of Object.values(db.pharmacyLoyaltyPointsEntry)) {
      expect(method).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-a', branchId: 'branch-a', customerId: 'customer-a' },
        })
      );
    }
    expect(db.pharmacyLoyaltyPointsEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 25,
        take: 25,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      })
    );
    expect(db.pharmacyLoyaltyPointsEntry.aggregate.mock.calls[0]?.[0]).not.toHaveProperty('skip');
  });
  it.each([0, -1, 1.5, NaN, Infinity, 10001])(
    'rejects invalid page %s before reads',
    async (page) => {
      const db = fixture();
      await expect(readLoyaltyHistory(db as never, scope, 'customer-a', page)).rejects.toThrow(
        'INVALID_HISTORY_PAGE'
      );
      expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
    }
  );
  it('rejects an inactive, absent or foreign branch before customer access', async () => {
    const db = fixture();
    db.pharmacyBranch.findFirst.mockResolvedValue(null);
    await expect(readLoyaltyHistory(db as never, scope, 'customer-a')).rejects.toThrow(
      'CUSTOMER_NOT_FOUND'
    );
    await expect(listLoyaltyCustomers(db as never, scope)).rejects.toThrow('CUSTOMER_NOT_FOUND');
    expect(db.pharmacyCustomer.findFirst).not.toHaveBeenCalled();
    expect(db.pharmacyCustomer.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).not.toHaveBeenCalled();
  });
  it('requires an active customer in the current tenant before any ledger reads', async () => {
    const db = fixture();
    db.pharmacyCustomer.findFirst.mockResolvedValue(null);
    await expect(readLoyaltyHistory(db as never, scope, 'foreign-customer')).rejects.toThrow(
      'CUSTOMER_NOT_FOUND'
    );
    expect(db.pharmacyCustomer.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-customer', organizationId: 'org-a', active: true },
      select: { id: true, displayName: true, phoneLast4: true, preferredLanguage: true },
    });
    expect(db.pharmacyLoyaltyPointsEntry.findMany).not.toHaveBeenCalled();
  });
  it('returns an empty zero balance and clamps a stale page to the final page', async () => {
    const db = fixture();
    db.pharmacyLoyaltyPointsEntry.count.mockResolvedValue(0);
    db.pharmacyLoyaltyPointsEntry.aggregate.mockResolvedValue({ _sum: { points: null } });
    expect(await readLoyaltyHistory(db as never, scope, 'customer-a', 999)).toMatchObject({
      page: 1,
      pageCount: 1,
      pointsBalance: 0,
      entries: [],
      hasNext: false,
    });
    expect(db.pharmacyLoyaltyPointsEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0 })
    );
  });
  it('returns source references and signed reversal rows without recomputing accounting', async () => {
    const db = fixture();
    const rows = ['EARN', 'REDEEM', 'REFUND', 'EARN_REVERSAL'].map((kind, i) => ({
      id: `entry-${i}`,
      kind,
      points: [20, -10, 5, -1][i],
      saleId: 'sale-a',
      tenderId: 'tender-a',
      refundId: i > 1 ? 'refund-a' : null,
      sale: { receiptNumber: 12, receiptDeviceId: 'counter-a' },
    }));
    db.pharmacyLoyaltyPointsEntry.findMany.mockResolvedValue(rows);
    expect((await readLoyaltyHistory(db as never, scope, 'customer-a')).entries).toEqual(rows);
    expect(db.pharmacyLoyaltyPointsEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          kind: true,
          points: true,
          occurredAt: true,
          saleId: true,
          tenderId: true,
          refundId: true,
          sale: { select: { receiptNumber: true, receiptDeviceId: true } },
        },
      })
    );
  });
  it('keeps a sibling branch selection explicit in all ledger predicates', async () => {
    const db = fixture();
    await readLoyaltyHistory(db as never, { ...scope, branchId: 'branch-b' }, 'customer-a');
    for (const method of Object.values(db.pharmacyLoyaltyPointsEntry))
      expect(method).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-a', branchId: 'branch-b', customerId: 'customer-a' },
        })
      );
  });
  it('stops at the maximum page without generating an invalid next request', async () => {
    const db = fixture();
    db.pharmacyLoyaltyPointsEntry.count.mockResolvedValue(250001);
    expect(await readLoyaltyHistory(db as never, scope, 'customer-a', 10000)).toMatchObject({
      hasNext: false,
      historyLimitReached: true,
    });
  });
  it('caps directory results and selects only retail identity fields', async () => {
    const db = fixture();
    db.pharmacyCustomer.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({ id: String(i) }))
    );
    const result = await listLoyaltyCustomers(db as never, scope, '  Ali  ');
    expect(result.customers).toHaveLength(50);
    expect(result.hasMore).toBe(true);
    expect(db.pharmacyCustomer.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        active: true,
        displayName: { contains: 'Ali', mode: 'insensitive' },
      },
      select: { id: true, displayName: true, phoneLast4: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 51,
    });
  });
  it('rejects oversized search before database reads', async () => {
    const db = fixture();
    await expect(listLoyaltyCustomers(db as never, scope, 'x'.repeat(101))).rejects.toThrow(
      'INVALID_CUSTOMER_QUERY'
    );
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  });
});
