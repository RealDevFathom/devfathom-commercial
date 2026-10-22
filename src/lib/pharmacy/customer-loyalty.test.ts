import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const consent = vi.hoisted(() => ({ lockCustomerConsent: vi.fn() }));
vi.mock('./consent-writer', () => consent);

import { pointsForNetPaid, redemptionFor } from '@/lib/commerce/loyalty-arithmetic';

import {
  accrueSalePoints,
  linkCustomerToSale,
  PharmacyLoyaltyError,
  readCustomerSnapshot,
  restoreRefundedLoyaltyPoints,
} from './customer-loyalty';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

/** Raw reads by table: the points-account lock finds its one customer row. */
function raw(policy: unknown[] = [], order: string[] = []) {
  return vi.fn(async (query: { sql?: string }) => {
    if (String(query.sql).includes('FROM pharmacy_customers')) {
      order.push('lock-account');
      return [{ id: 'customer-a' }];
    }
    return policy;
  });
}

describe('CRM-L01 pharmacy loyalty', () => {
  it('links a retail customer only with current purpose-specific LOYALTY consent', async () => {
    const update = vi.fn();
    const db = {
      patientConsent: {
        findFirst: vi.fn().mockResolvedValue({ granted: false, revokedAt: new Date() }),
      },
      pharmacySale: { findFirst: vi.fn(), update },
      pharmacyCustomer: { upsert: vi.fn() },
    };
    await expect(
      linkCustomerToSale(db as never, scope, {
        saleId: 'sale-a',
        patientId: 'patient-a',
        displayName: 'Retail name',
      })
    ).rejects.toEqual(new PharmacyLoyaltyError('LOYALTY_CONSENT_REQUIRED'));
    expect(db.patientConsent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ purpose: 'LOYALTY', organizationId: 'org-a' }),
        orderBy: [{ version: 'desc' }, { recordedAt: 'desc' }],
      })
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('accrues whole points from net paid excluding loyalty tender', async () => {
    expect(pointsForNetPaid(10_099)).toBe(100);
    const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'earn-a', ...data }));
    const db = {
      pharmacyLoyaltyPointsEntry: { findUnique: vi.fn().mockResolvedValue(null), create },
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sale-a',
          customerId: 'customer-a',
          tenders: [
            { type: 'CASH', amountMinor: 10_099 },
            { type: 'LOYALTY', amountMinor: 500 },
          ],
          lines: [
            {
              quantity: 1,
              unitPriceMinor: 10_099,
              discountMinor: 0,
              medicine: { productFamily: 'PHARMACEUTICAL' },
            },
          ],
        }),
      },
      $queryRaw: raw(),
    };
    await accrueSalePoints(db as never, scope, 'sale-a');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ points: 1, netPaidMinor: 10_099, kind: 'EARN' }),
    });
  });

  it('locks the customer points account before it writes an earn', async () => {
    const order: string[] = [];
    const create = vi.fn().mockImplementation(async ({ data }) => {
      order.push('earn');
      return { id: 'earn-a', ...data };
    });
    const db = {
      pharmacyLoyaltyPointsEntry: { findUnique: vi.fn().mockResolvedValue(null), create },
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sale-a',
          customerId: 'customer-a',
          tenders: [{ type: 'CASH', amountMinor: 20_000 }],
          lines: [
            {
              quantity: 1,
              unitPriceMinor: 20_000,
              discountMinor: 0,
              medicine: { productFamily: 'PHARMACEUTICAL' },
            },
          ],
        }),
      },
      $queryRaw: raw([], order),
    };
    await accrueSalePoints(db as never, scope, 'sale-a');
    expect(order).toEqual(['lock-account', 'earn']);
    expect(create.mock.calls[0]![0].data.expiresAt).toBeInstanceOf(Date);
  });

  it('qualifies Gold spend within the current tenant branch only', async () => {
    const aggregate = vi.fn().mockResolvedValue({ _sum: { netPaidMinor: 5_000_000 } });
    const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'earn-a', ...data }));
    const db = {
      $queryRaw: raw([
        {
          medicineEarnPoints: 1,
          nonDrugEarnPoints: 3,
          earnBlockMinor: 10_000,
          pointValueMinor: 100,
          minimumRedemptionPoints: 200,
          pointsExpiryMonths: 6,
          goldTierEnabled: true,
          goldTierThresholdMinor: 5_000_000,
          goldTierMultiplier: 2,
        },
      ]),
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn().mockResolvedValue(null),
        aggregate,
        create,
      },
      pharmacySale: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'sale-a',
          customerId: 'customer-a',
          tenders: [{ type: 'CASH', amountMinor: 10_000 }],
          lines: [
            {
              quantity: 1,
              unitPriceMinor: 10_000,
              discountMinor: 0,
              medicine: { productFamily: 'PHARMACEUTICAL' },
            },
          ],
        }),
      },
    };

    await accrueSalePoints(db as never, scope, 'sale-a');

    expect(aggregate).toHaveBeenCalledWith({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        customerId: 'customer-a',
        kind: 'EARN',
        occurredAt: { gte: expect.any(Date) },
      },
      _sum: { netPaidMinor: true },
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ points: 2, branchId: scope.branchId }),
    });
  });

  it('replays an existing earn without appending another ledger row', async () => {
    const prior = { id: 'earn-a', points: 12, idempotencyKey: 'loyalty:earn:sale-a' };
    const create = vi.fn();
    const db = {
      pharmacyLoyaltyPointsEntry: { findUnique: vi.fn().mockResolvedValue(prior), create },
    };
    await expect(accrueSalePoints(db as never, scope, 'sale-a')).resolves.toMatchObject({
      id: 'earn-a',
      replayed: true,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects insufficient points and caps redemption at outstanding sale value', () => {
    expect(() =>
      redemptionFor({ requestedPoints: 11, availablePoints: 10, outstandingMinor: 5_000 })
    ).toThrow('INSUFFICIENT_POINTS');
    expect(
      redemptionFor({ requestedPoints: 50, availablePoints: 50, outstandingMinor: 1_275 })
    ).toEqual({ points: 12, amountMinor: 1_200 });
  });

  it('restores refunded loyalty points once with an auditable refund link', async () => {
    let created: Record<string, unknown> | null = null;
    const create = vi.fn().mockImplementation(async ({ data }) => {
      created = { id: 'offset-a', ...data };
      return created;
    });
    const db = {
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn().mockImplementation(async () => created),
        findFirst: vi.fn().mockResolvedValue({ points: -20, tender: { amountMinor: 2_000 } }),
        aggregate: vi.fn().mockResolvedValue({ _sum: { points: 5 } }),
        create,
      },
      pharmacyRefund: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 2_000 } }),
      },
    };
    const input = {
      refundId: 'refund-a',
      tenderId: 'tender-a',
      saleId: 'sale-a',
      customerId: 'customer-a',
    };
    const first = await restoreRefundedLoyaltyPoints(db as never, scope, input);
    const replay = await restoreRefundedLoyaltyPoints(db as never, scope, input);
    expect(first).toMatchObject({
      kind: 'REFUND',
      points: 15,
      refundId: 'refund-a',
      tenderId: 'tender-a',
      replayed: false,
    });
    expect(replay).toMatchObject({ id: 'offset-a', replayed: true });
    expect(create).toHaveBeenCalledTimes(1);
    // Same lock order as redemption and earn reversal: consent, then the points account.
    expect(consent.lockCustomerConsent).toHaveBeenCalledWith(db, 'org-a', 'customer-a');
  });

  it('restores at the redemption own point value, not a fixed Rs 1 per point', async () => {
    // 400 points bought Rs 200 (a 50-paisa point); half the tender is refunded.
    const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'offset-b', ...data }));
    const db = {
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue({ points: -400, tender: { amountMinor: 20_000 } }),
        aggregate: vi.fn().mockResolvedValue({ _sum: { points: null } }),
        create,
      },
      pharmacyRefund: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { amountMinor: 10_000 } }),
      },
    };
    await expect(
      restoreRefundedLoyaltyPoints(db as never, scope, {
        refundId: 'refund-b',
        tenderId: 'tender-b',
        saleId: 'sale-b',
        customerId: 'customer-a',
      })
    ).resolves.toMatchObject({ kind: 'REFUND', points: 200 });
  });

  it('returns counter history, points and khata visibility without patient fields', async () => {
    const db = {
      pharmacyCustomer: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'customer-a',
          displayName: 'Retail name',
          phoneLast4: '1234',
          creditLimitMinor: 20_000,
        }),
      },
      pharmacyLoyaltyPointsEntry: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { points: 35 } }),
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      pharmacySale: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'sale-a',
            receiptNumber: 7,
            completedAt: new Date('2026-09-04T10:00:00Z'),
            lines: [{ quantity: 2, unitPriceMinor: 500, discountMinor: 100 }],
            tenders: [{ type: 'CREDIT', amountMinor: 900, refunds: [{ amountMinor: 100 }] }],
          },
        ]),
      },
    };
    const snapshot = await readCustomerSnapshot(db as never, scope, 'customer-a');
    expect(snapshot).toMatchObject({
      pointsBalance: 35,
      creditBalanceMinor: 800,
      availableCreditMinor: 19_200,
      history: [{ receiptNumber: 7, totalMinor: 900 }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/patient|cnic|prescription/i);
    expect(db.pharmacySale.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-a', branchId: 'branch-a' }),
      })
    );
  });
});
