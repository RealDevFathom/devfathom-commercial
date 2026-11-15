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
    pharmacyLoyaltyPointsEntry: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { points: 14 } }),
      count: vi.fn().mockResolvedValue(26),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}
// Directory reads also total branch balances; history tests keep the narrower ledger mock.
function directoryFixture() {
  const db = fixture();
  return {
    ...db,
    pharmacyLoyaltyPointsEntry: {
      ...db.pharmacyLoyaltyPointsEntry,
      groupBy: vi.fn().mockResolvedValue([]),
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
    const where = { organizationId: 'org-a', branchId: 'branch-a', customerId: 'customer-a' };
    // DEV-764: the balance sums every entry; the listing leaves out only zero-point lot closures.
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where })
    );
    for (const method of [
      db.pharmacyLoyaltyPointsEntry.count,
      db.pharmacyLoyaltyPointsEntry.findMany,
    ])
      expect(method).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ...where, NOT: { kind: 'EXPIRY', points: 0 } } })
      );
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
          reason: true,
          expiresAt: true,
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
          where: expect.objectContaining({
            organizationId: 'org-a',
            branchId: 'branch-b',
            customerId: 'customer-a',
          }),
        })
      );
    expect(db.pharmacyLoyaltyPointsEntry.aggregate).toHaveBeenCalledWith(
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
    const db = directoryFixture();
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
        AND: [
          {
            OR: [
              { displayName: { contains: 'Ali', mode: 'insensitive' } },
              { patient: { displayName: { contains: 'Ali', mode: 'insensitive' } } },
              { id: 'Ali' },
            ],
          },
        ],
      },
      select: { id: true, displayName: true, phoneLast4: true },
      orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
      take: 51,
    });
  });
  it('lists every active customer with branch balances when no search is entered', async () => {
    const db = directoryFixture();
    db.pharmacyCustomer.findMany.mockResolvedValue([
      { id: 'customer-a', displayName: 'Ahmed Raza', phoneLast4: '4567' },
      { id: 'customer-b', displayName: 'Sana Khan', phoneLast4: null },
    ]);
    db.pharmacyLoyaltyPointsEntry.groupBy.mockResolvedValue([
      { customerId: 'customer-a', _sum: { points: 120 } },
    ]);
    const result = await listLoyaltyCustomers(db as never, scope, '');
    expect(db.pharmacyCustomer.findMany.mock.calls[0]?.[0].where).toEqual({
      organizationId: 'org-a',
      active: true,
    });
    expect(db.pharmacyLoyaltyPointsEntry.groupBy).toHaveBeenCalledWith({
      by: ['customerId'],
      where: {
        organizationId: 'org-a',
        branchId: 'branch-a',
        customerId: { in: ['customer-a', 'customer-b'] },
      },
      _sum: { points: true },
    });
    expect(result.customers).toEqual([
      { id: 'customer-a', displayName: 'Ahmed Raza', phoneLast4: '4567', pointsBalance: 120 },
      { id: 'customer-b', displayName: 'Sana Khan', phoneLast4: null, pointsBalance: 0 },
    ]);
  });
  it('finds a customer by patient name when the loyalty name snapshot differs', async () => {
    const db = directoryFixture();
    await listLoyaltyCustomers(db as never, scope, 'ahmed  raza');
    const where = db.pharmacyCustomer.findMany.mock.calls[0]?.[0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0].OR).toContainEqual({
      patient: { displayName: { contains: 'ahmed', mode: 'insensitive' } },
    });
    expect(where.AND[1].OR).toContainEqual({
      displayName: { contains: 'raza', mode: 'insensitive' },
    });
  });
  it('finds a customer by phone number and by loyalty number', async () => {
    const db = directoryFixture();
    await listLoyaltyCustomers(db as never, scope, '0300-1234567');
    let [term] = db.pharmacyCustomer.findMany.mock.calls[0]?.[0].where.AND;
    expect(term.OR).toContainEqual({ patient: { phone: { contains: '3001234567' } } });
    await listLoyaltyCustomers(db as never, scope, '4567');
    [term] = db.pharmacyCustomer.findMany.mock.calls[1]?.[0].where.AND;
    expect(term.OR).toContainEqual({ phoneLast4: '4567' });
    await listLoyaltyCustomers(db as never, scope, 'cmh0loyalty01');
    [term] = db.pharmacyCustomer.findMany.mock.calls[2]?.[0].where.AND;
    expect(term.OR).toContainEqual({ id: 'cmh0loyalty01' });
    expect(term.OR).not.toContainEqual(expect.objectContaining({ phoneLast4: expect.anything() }));
  });
  it('skips the balance read when nothing matches', async () => {
    const db = directoryFixture();
    expect(await listLoyaltyCustomers(db as never, scope, 'Nobody')).toEqual({
      customers: [],
      hasMore: false,
    });
    expect(db.pharmacyLoyaltyPointsEntry.groupBy).not.toHaveBeenCalled();
  });
  it('rejects oversized search before database reads', async () => {
    const db = fixture();
    await expect(listLoyaltyCustomers(db as never, scope, 'x'.repeat(101))).rejects.toThrow(
      'INVALID_CUSTOMER_QUERY'
    );
    expect(db.pharmacyBranch.findFirst).not.toHaveBeenCalled();
  });
});
