import 'server-only';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { lockCustomerConsent } from './consent-writer';
import { postLoyaltyReleaseEntry } from './finance-postings';
import { expireStrandedRestoration } from './loyalty-expiry';
import type { LedgerScope } from './stock-ledger';

/**
 * DEV-764: a sale voided with a points redemption on it gives the points back. Runs inside the
 * void, after the sale row has been claimed VOID in the same transaction. For each points
 * tender, the part not already refunded is released: the customer gets back every redeemed
 * point not already restored by a refund, and the redemption's settlement is reversed in the
 * books. One release per tender, so a replay changes nothing. No money moves, so this is not
 * a refund and needs no refund authority.
 */
export async function releaseVoidedSaleRedemptions(
  db: ScopedDb,
  scope: LedgerScope,
  saleId: string
) {
  const tenders = await db.pharmacyTender.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId,
      type: 'LOYALTY',
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, amountMinor: true, refunds: { select: { amountMinor: true } } },
  });
  const released: { tenderId: string; points: number; amountMinor: number }[] = [];
  for (const tender of tenders) {
    const releaseMinor =
      tender.amountMinor - tender.refunds.reduce((sum, refund) => sum + refund.amountMinor, 0);
    if (releaseMinor <= 0) continue;
    const redemption = await db.pharmacyLoyaltyPointsEntry.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        tenderId: tender.id,
        kind: 'REDEEM',
      },
      select: { customerId: true, points: true },
    });
    if (!redemption) throw new Error('Points tender has no redemption entry.');
    await lockCustomerConsent(db, scope.organizationId, redemption.customerId);
    const key = `loyalty:release:${tender.id}`;
    const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: scope.organizationId,
          idempotencyKey: key,
        },
      },
    });
    if (!prior) {
      const restored = await db.pharmacyLoyaltyPointsEntry.aggregate({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          tenderId: tender.id,
          kind: 'REFUND',
        },
        _sum: { points: true },
      });
      const points = -redemption.points - (restored._sum.points ?? 0);
      if (points > 0) {
        const entry = await db.pharmacyLoyaltyPointsEntry.create({
          data: {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            customerId: redemption.customerId,
            saleId,
            tenderId: tender.id,
            kind: 'REDEMPTION_RELEASE',
            points,
            actorId: scope.actorId,
            idempotencyKey: key,
          },
        });
        // The points go back into the lots they were redeemed from, with those lots' expiry
        // dates; any that land in a lot already expired are expired again at once.
        await expireStrandedRestoration(
          db,
          {
            organizationId: scope.organizationId,
            branchId: scope.branchId,
            customerId: redemption.customerId,
          },
          entry,
          new Date()
        );
      }
      released.push({
        tenderId: tender.id,
        points: Math.max(0, points),
        amountMinor: releaseMinor,
      });
    }
    await postLoyaltyReleaseEntry(db, scope, {
      tenderId: tender.id,
      amountMinor: releaseMinor,
      at: new Date(),
    });
  }
  return released;
}
