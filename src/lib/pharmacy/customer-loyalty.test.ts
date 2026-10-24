import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { pointsForNetPaid, redemptionFor } from '@/lib/commerce/loyalty-arithmetic';

import {
  accrueSalePoints,
  linkCustomerToSale,
  PharmacyLoyaltyError,
  readCustomerSnapshot,
  restoreRefundedLoyaltyPoints,
} from './customer-loyalty';

const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

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
        }),
      },
    };
    await accrueSalePoints(db as never, scope, 'sale-a');
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ points: 100, netPaidMinor: 10_099, kind: 'EARN' }),
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
        findFirst: vi.fn().mockResolvedValue({ points: -20 }),
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
