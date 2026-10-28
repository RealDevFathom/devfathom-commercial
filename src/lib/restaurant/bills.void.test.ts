import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { removeVoidedItemFromBills } from './bills';
const D = (value: string) => new Prisma.Decimal(value);
function fixture(overrides = {}) {
  const bill = {
    id: 'bill',
    status: 'OPEN',
    splitKind: 'NONE',
    tenders: [],
    subtotal: D('100'),
    compTotal: D('0'),
    taxTotal: D('0'),
    grandTotal: D('110'),
    serviceChargeTotal: D('10'),
    serviceChargeBasis: D('100'),
    serviceChargePolicyVersionId: 'pinned',
    lines: [
      {
        id: 'line',
        orderItemId: 'item',
        lineSubtotal: D('40'),
        compAmount: D('0'),
        serviceChargeAmount: D('4'),
        lineTotal: D('44'),
      },
    ],
    ...overrides,
  };
  const db = {
    $queryRaw: vi.fn(),
    restaurantBill: {
      findMany: vi.fn(async () => [bill]),
      update: vi.fn(async (args: { data: Record<string, Prisma.Decimal> }) => args),
    },
    restaurantBillLine: { delete: vi.fn() },
  };
  return { db, run: () => removeVoidedItemFromBills(db as unknown as ScopedDb, 'order', 'item') };
}
describe('void after bill cut (#273)', () => {
  it('removes the 40 line and its 4 service, preserving the pinned remaining allocation', async () => {
    const { db, run } = fixture();
    await run();
    const data = db.restaurantBill.update.mock.calls[0][0].data;
    expect(data.subtotal.toFixed(2)).toBe('60.00');
    expect(data.serviceChargeTotal.toFixed(2)).toBe('6.00');
    expect(data.serviceChargeBasis.toFixed(2)).toBe('60.00');
    expect(data.grandTotal.toFixed(2)).toBe('66.00');
    expect(db.restaurantBillLine.delete).toHaveBeenCalledWith({ where: { id: 'line' } });
    expect(db.$queryRaw).toHaveBeenCalledBefore(db.restaurantBill.findMany);
  });
  it.each([{ status: 'SETTLED' }, { tenders: [{ id: 'tender' }] }, { splitKind: 'FRACTIONAL' }])(
    'blocks unsafe changes before writing: %j',
    async (overrides) => {
      const { db, run } = fixture(overrides);
      await expect(run()).rejects.toThrow(/re-cut/);
      expect(db.restaurantBillLine.delete).not.toHaveBeenCalled();
    }
  );
});
