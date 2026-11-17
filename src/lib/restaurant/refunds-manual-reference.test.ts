import { describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { refundTender } from './refunds';

const D = (value: string) => new Prisma.Decimal(value);
const input = {
  originalTenderId: 'tender-1',
  amount: '5.00',
  reason: 'Returned meal',
  approvingStaffProfileId: 'manager-1',
  actor: { staffProfileId: 'cashier-2', deviceId: 'device-1', idempotencyKey: 'refund-1' },
  now: new Date('2026-08-19T12:00:00Z'),
};
function refundDb(provider = 'MANUAL') {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    restaurantRegisteredDevice: { findFirst: vi.fn().mockResolvedValue({ branchId: 'branch-1' }) },
    restaurantTender: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'tender-1',
        type: 'CARD',
        amount: D('10.00'),
        tipAmount: D('0'),
        billId: 'bill-1',
        businessDate: new Date('2026-08-19'),
        paymentId: 'payment-1',
        bill: {
          branchId: 'branch-1',
          serviceChargeTotal: D('0'),
          deliveryFeeTotal: D('0'),
          roundingAdjustment: D('0'),
          tenders: [{ id: 'tender-1', amount: D('10.00') }],
        },
      }),
    },
    restaurantBill: { findFirst: vi.fn().mockResolvedValue({ id: 'bill-1' }) },
    restaurantPayment: {
      findUnique: vi.fn().mockResolvedValue({ id: 'payment-1', provider, providerRef: 'sale-ref' }),
      update: vi.fn(),
    },
    restaurantMoneyIdempotencyKey: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi
        .fn<(input: { data: { canonicalPayloadHash: string } }) => Promise<void>>()
        .mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    restaurantRefund: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { roundingRefundAmount: D('0') } }),
      create: vi.fn().mockResolvedValue({ id: 'refund-1' }),
    },
    restaurantTaxTenderAllocationSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    restaurantBranch: {
      findUnique: vi.fn().mockResolvedValue({
        organizationId: 'org-1',
        timezone: 'UTC',
        businessDayCutoff: '04:00',
      }),
    },
    restaurantDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    restaurantCoAuthorization: { create: vi.fn().mockResolvedValue({ id: 'coauth-1' }) },
    loyaltyPointsEntry: { findFirst: vi.fn().mockResolvedValue(null) },
    restaurantPaymentEvent: { create: vi.fn().mockResolvedValue({ id: 'event-1' }) },
  };
  const db = {
    $transaction: (work: (scoped: ScopedDb) => Promise<unknown>) => work(tx as unknown as ScopedDb),
  } as unknown as ScopedDb;
  return { db, tx };
}

describe('manual card refund reference command', () => {
  it('persists the trimmed reference on the refund and audit event and binds the idempotent payload to it', async () => {
    const { db, tx } = refundDb();
    await refundTender(db, { ...input, cardMachineRefundReference: ' BANK-REF-42 ' });
    expect(tx.restaurantRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cardMachineRefundReference: 'BANK-REF-42' }),
      })
    );
    expect(tx.restaurantPaymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: 'REFUND_MANUALLY_RECORDED',
          providerRef: 'sale-ref',
          payload: expect.objectContaining({ cardMachineRefundReference: 'BANK-REF-42' }),
        }),
      })
    );
    const firstHash =
      tx.restaurantMoneyIdempotencyKey.create.mock.calls[0][0].data.canonicalPayloadHash;
    const second = refundDb();
    await refundTender(second.db, { ...input, cardMachineRefundReference: 'BANK-REF-43' });
    expect(
      second.tx.restaurantMoneyIdempotencyKey.create.mock.calls[0][0].data.canonicalPayloadHash
    ).not.toBe(firstHash);
  });
  it('keeps the reference optional', async () => {
    const { db, tx } = refundDb();
    await refundTender(db, input);
    expect(tx.restaurantRefund.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ cardMachineRefundReference: null }),
      })
    );
  });
  it('rejects overlong references before any ledger writes', async () => {
    const { db, tx } = refundDb();
    await expect(
      refundTender(db, { ...input, cardMachineRefundReference: 'x'.repeat(41) })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
    expect(tx.restaurantRefund.create).not.toHaveBeenCalled();
  });
  it('rejects card-number-shaped references before any ledger writes', async () => {
    for (const bad of [
      '4111111111111111',
      '4111-1111-1111-1111',
      '4111/1111/1111/1111',
      '4111.1111.1111.1111',
      '\u0664\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661\u0661',
      'REF 42',
    ]) {
      const { db, tx } = refundDb();
      await expect(
        refundTender(db, { ...input, cardMachineRefundReference: bad })
      ).rejects.toMatchObject({ reason: 'INVALID' });
      expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
      expect(tx.restaurantRefund.create).not.toHaveBeenCalled();
    }
  });
  it('rejects references for non-manual providers before claiming an idempotency key', async () => {
    const { db, tx } = refundDb('MOCK');
    await expect(
      refundTender(db, { ...input, cardMachineRefundReference: 'BANK-REF-42' })
    ).rejects.toMatchObject({ reason: 'INVALID' });
    expect(tx.restaurantMoneyIdempotencyKey.create).not.toHaveBeenCalled();
    expect(tx.restaurantRefund.create).not.toHaveBeenCalled();
  });
});
