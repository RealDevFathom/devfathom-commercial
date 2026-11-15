import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/pharmacy/finance-postings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/finance-postings')>()),
  postTenderRefundEntry: vi.fn(),
}));

import { restoreRefundedLoyaltyPoints } from '@/lib/pharmacy/customer-loyalty';
import { refundPharmacyTender } from '@/lib/pharmacy/settlement';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const scope = { organizationId: 'org-1', branchId: 'branch-1', actorId: 'manager-1' };
const input = {
  originalTenderId: 'points-tender',
  deviceId: 'device-1',
  businessDate: new Date('2026-11-15'),
  amountMinor: 2_000,
  reason: 'Customer asked for points back',
  idempotencyKey: 'refund-after-void',
};

function fixture(saleStatus: string) {
  let payloadHash = '';
  return {
    $executeRaw: vi.fn(async (query: { values: unknown[] }) => {
      payloadHash = String(query.values[5]);
      return 1;
    }),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyMoneyIdempotencyKey: {
      findUnique: vi.fn(async () => ({ id: 'idem-1', commandType: 'refund', payloadHash })),
      update: vi.fn().mockResolvedValue({}),
    },
    pharmacyTender: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'points-tender',
        saleId: 'sale-1',
        type: 'LOYALTY',
        amountMinor: 2_000,
        refunds: [],
        sale: { customerId: 'customer-1', status: saleStatus },
      }),
    },
    pharmacySale: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyRefund: { create: vi.fn() },
  };
}

describe('DEV-764 a voided sale releases its points tender exactly once', () => {
  it('refuses to refund a points tender its void already released', async () => {
    const db = fixture('VOID');
    await expect(refundPharmacyTender(db as unknown as ScopedDb, scope, input)).rejects.toThrow(
      'REFUND_EXCEEDS_TENDER'
    );
    expect(db.pharmacyRefund.create).not.toHaveBeenCalled();
  });

  it('counts released points when restoring points on a later refund', async () => {
    const create = vi.fn();
    const aggregate = vi.fn().mockResolvedValue({ _sum: { points: 20 } });
    const db = {
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue({ points: -20, tender: { amountMinor: 2_000 } }),
        aggregate,
        create,
      },
      pharmacyRefund: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 2_000 } }),
      },
    };
    await expect(
      restoreRefundedLoyaltyPoints(db as never, scope, {
        refundId: 'refund-1',
        tenderId: 'points-tender',
        saleId: 'sale-1',
        customerId: 'customer-1',
      })
    ).resolves.toBeNull();
    expect(aggregate).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        tenderId: 'points-tender',
        kind: { in: ['REFUND', 'REDEMPTION_RELEASE'] },
      },
      _sum: { points: true },
    });
    expect(create).not.toHaveBeenCalled();
  });
});
