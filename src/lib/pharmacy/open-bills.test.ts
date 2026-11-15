import { describe, expect, it, vi } from 'vitest';

import { listOpenBills, OPEN_BILLS_LIMIT } from './open-bills';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };

function fixture(sales: unknown[], users = [{ id: 'cashier-a', name: 'Cashier A' }]) {
  return {
    pharmacySale: { findMany: vi.fn(async () => sales) },
    user: { findMany: vi.fn(async () => users) },
  };
}

describe('listOpenBills (DEV-623)', () => {
  it('reads only the branch’s OPEN and HELD bills, oldest first and bounded', async () => {
    const db = fixture([]);

    await expect(listOpenBills(db as never, scope)).resolves.toEqual([]);

    expect(db.pharmacySale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-a',
          branchId: 'branch-a',
          status: { in: ['OPEN', 'HELD'] },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: OPEN_BILLS_LIMIT,
      })
    );
    expect(db.user.findMany).not.toHaveBeenCalled();
  });

  it('reports the stock each stranded bill holds, its value and who opened it', async () => {
    const createdAt = new Date('2026-11-02T18:15:00.000Z');
    const db = fixture([
      {
        id: 'sale-reload',
        status: 'OPEN',
        createdAt,
        updatedAt: createdAt,
        createdByUserId: 'cashier-a',
        customerOrder: null,
        lines: [
          {
            quantity: 2,
            unitPriceMinor: 1500,
            grossMinor: 3000,
            discountMinor: 0,
            canonicalUnits: 20,
          },
          {
            quantity: 1,
            unitPriceMinor: 900,
            grossMinor: 900,
            discountMinor: 100,
            canonicalUnits: 10,
          },
        ],
        tenders: [{ amountMinor: 500 }],
      },
      {
        id: 'sale-held',
        status: 'HELD',
        createdAt,
        updatedAt: createdAt,
        createdByUserId: 'former-member',
        customerOrder: { id: 'order-a' },
        lines: [],
        tenders: [],
      },
    ]);

    const bills = await listOpenBills(db as never, scope);

    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-a', id: { in: ['cashier-a', 'former-member'] } },
      select: { id: true, name: true },
    });
    expect(bills).toEqual([
      {
        saleId: 'sale-reload',
        status: 'OPEN',
        createdAt,
        updatedAt: createdAt,
        openedBy: 'Cashier A',
        lineCount: 2,
        reservedUnits: 30,
        netMinor: 3800,
        tenderedMinor: 500,
        customerOrder: false,
      },
      {
        saleId: 'sale-held',
        status: 'HELD',
        createdAt,
        updatedAt: createdAt,
        openedBy: null,
        lineCount: 0,
        reservedUnits: 0,
        netMinor: 0,
        tenderedMinor: 0,
        customerOrder: true,
      },
    ]);
  });
});
