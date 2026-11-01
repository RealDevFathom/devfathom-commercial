import { describe, expect, it, vi } from 'vitest';
import { accrueSalePoints, restoreRefundedLoyaltyPoints } from './customer-loyalty';
import { reverseRefundedEarnedPoints } from './customer-loyalty-earned-reversal';
import { redemptionFor } from '@/lib/commerce/loyalty-arithmetic';
vi.mock('./consent-writer', () => ({ lockCustomerConsent: vi.fn(), lockPatientConsent: vi.fn() }));
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
function fixture() {
  return {
    pharmacyLoyaltySettings: {
      findUnique: vi.fn(async () => ({
        pointsEnabled: true,
        earnEveryMinor: 1000,
        pointValueMinor: 50,
        minimumRedeemPoints: 5,
      })),
    },
    pharmacySale: {
      findFirst: vi.fn(async () => ({
        id: 'sale',
        customerId: 'customer',
        status: 'COMPLETED',
        tenders: [
          { type: 'CASH', amountMinor: 10500 },
          { type: 'LOYALTY', amountMinor: 500 },
        ],
      })),
    },
    pharmacyCustomer: { findFirst: vi.fn(async () => ({ patientId: 'patient' })) },
    patientConsent: {
      findFirst: vi.fn(async () => ({ granted: true, revokedAt: null as Date | null })),
    },
    pharmacyLoyaltyPointsEntry: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => data),
    },
  };
}
describe('configured points and strict consent', () => {
  it.each(['OPEN', 'HELD', 'QUOTATION', 'VOID'])('never earns on a %s sale', async (status) => {
    const db = fixture();
    const sale = await db.pharmacySale.findFirst();
    sale.status = status;
    db.pharmacySale.findFirst.mockResolvedValue(sale);
    expect(await accrueSalePoints(db as never, scope, 'sale')).toBeNull();
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
  it.each(['revoked', 'absent', 'denied', 'disabled'])('does not earn when %s', async (state) => {
    const db = fixture();
    if (state === 'absent') db.patientConsent.findFirst.mockResolvedValue(null as never);
    if (state === 'denied')
      db.patientConsent.findFirst.mockResolvedValue({ granted: false, revokedAt: null });
    if (state === 'revoked')
      db.patientConsent.findFirst.mockResolvedValue({ granted: true, revokedAt: new Date() });
    if (state === 'disabled')
      db.pharmacyLoyaltySettings.findUnique.mockResolvedValue({
        pointsEnabled: false,
        earnEveryMinor: 1000,
        pointValueMinor: 50,
        minimumRedeemPoints: 5,
      });
    expect(await accrueSalePoints(db as never, scope, 'sale')).toBeNull();
    expect(db.pharmacyLoyaltyPointsEntry.create).not.toHaveBeenCalled();
  });
  it('earns only at the configured completed-sale rate and freezes its refund basis', async () => {
    const db = fixture();
    expect(await accrueSalePoints(db as never, scope, 'sale')).toMatchObject({
      points: 10,
      earnEveryMinor: 1000,
      netPaidMinor: 10500,
      kind: 'EARN',
    });
  });
  it('caps tender by outstanding money and enforces configured minimum and value', () => {
    expect(
      redemptionFor({
        requestedPoints: 20,
        availablePoints: 30,
        outstandingMinor: 375,
        pointValueMinor: 50,
        minimumPoints: 5,
      })
    ).toEqual({ points: 7, amountMinor: 350 });
    expect(() =>
      redemptionFor({
        requestedPoints: 4,
        availablePoints: 30,
        outstandingMinor: 375,
        pointValueMinor: 50,
        minimumPoints: 5,
      })
    ).toThrow('REDEMPTION_BELOW_MINIMUM');
  });
  it('reverses earned points at the historical rate after a policy change', async () => {
    const db = {
      $queryRaw: vi.fn(),
      pharmacyRefund: {
        findFirst: vi.fn(async () => ({
          id: 'refund',
          saleId: 'sale',
          originalTenderId: 'tender',
          sale: { customerId: 'customer' },
          originalTender: { type: 'CASH', saleId: 'sale', branchId: 'branch' },
        })),
        aggregate: vi.fn(async () => ({ _sum: { amountMinor: 1501 } })),
      },
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ points: 10, netPaidMinor: 10500, earnEveryMinor: 1000 })),
        aggregate: vi.fn(async () => ({ _sum: { points: 0 } })),
        create: vi.fn(async ({ data }) => data),
      },
    };
    expect(await reverseRefundedEarnedPoints(db as never, scope, 'refund')).toMatchObject({
      points: -2,
      netPaidMinor: 8999,
    });
  });
  it('restores redeemed points using their original value rather than the current policy', async () => {
    const db = {
      pharmacyRefund: { aggregate: vi.fn(async () => ({ _sum: { amountMinor: 350 } })) },
      pharmacyLoyaltyPointsEntry: {
        findUnique: vi.fn(async () => null),
        findFirst: vi.fn(async () => ({ points: -10, pointValueMinor: 50 })),
        aggregate: vi.fn(async () => ({ _sum: { points: 0 } })),
        create: vi.fn(async ({ data }) => data),
      },
    };
    expect(
      await restoreRefundedLoyaltyPoints(db as never, scope, {
        refundId: 'refund',
        tenderId: 'tender',
        saleId: 'sale',
        customerId: 'customer',
      })
    ).toMatchObject({ points: 7, kind: 'REFUND' });
  });
});
