import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { compLine } from './bills';
import { RESTAURANT_CAPABILITIES } from '@/lib/vertical-catalog';
const D = (value: string) => new Prisma.Decimal(value);
function fixture() {
  const tx = {
    $queryRaw: vi.fn(),
    restaurantBill: {
      findFirst: vi.fn(async () => ({
        id: 'bill',
        status: 'OPEN',
        compTotal: D('0'),
        discountTotal: D('0'),
        grandTotal: D('110'),
        serviceChargeTotal: D('10'),
        serviceChargeBasis: D('100'),
        serviceChargePolicyVersionId: 'policy',
      })),
      update: vi.fn(),
    },
    restaurantBillLine: {
      findUnique: vi.fn(async () => ({
        id: 'line',
        billId: 'bill',
        lineSubtotal: D('40'),
        compAmount: D('0'),
        serviceChargeAmount: D('4'),
      })),
      update: vi.fn(),
    },
    restaurantMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(),
      update: vi.fn(),
    },
    restaurantCoAuthorization: {
      create: vi.fn(async (_args: { data: { capability: string } }) => ({ id: 'approval' })),
    },
  };
  return {
    tx,
    db: { $transaction: async (run: (tx: unknown) => unknown) => run(tx) } as unknown as ScopedDb,
  };
}
describe('comp audit capability (#275)', () => {
  it('records the same catalogued complimentary capability used by the route', async () => {
    const { db, tx } = fixture();
    await compLine(db, {
      billId: 'bill',
      branchId: 'branch',
      billLineId: 'line',
      reason: 'Hospitality',
      approvingStaffProfileId: 'manager',
      actor: { staffProfileId: 'actor', deviceId: 'device', idempotencyKey: 'key' },
    });
    const capability = tx.restaurantCoAuthorization.create.mock.calls[0][0].data.capability;
    expect(capability).toBe('orders:complimentary');
    expect(RESTAURANT_CAPABILITIES).toContain(capability);
  });
  it('continues to reject self approval', async () => {
    const { db, tx } = fixture();
    await expect(
      compLine(db, {
        billId: 'bill',
        branchId: 'branch',
        billLineId: 'line',
        reason: 'Hospitality',
        approvingStaffProfileId: 'actor',
        actor: { staffProfileId: 'actor', deviceId: 'device', idempotencyKey: 'key' },
      })
    ).rejects.toThrow(/must differ/);
    expect(tx.restaurantCoAuthorization.create).not.toHaveBeenCalled();
    expect(tx.restaurantBill.update).not.toHaveBeenCalled();
  });
});
