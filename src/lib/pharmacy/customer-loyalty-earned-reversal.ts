import 'server-only';

import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockCustomerConsent } from './consent-writer';
import type { LedgerScope } from './stock-ledger';

/** Internal refund transaction only. No provider calls or stock-return accrual. */
export async function reverseRefundedEarnedPoints(
  db: ScopedDb,
  scope: LedgerScope,
  refundId: string
) {
  const refund = await db.pharmacyRefund.findFirst({
    where: { id: refundId, organizationId: scope.organizationId, branchId: scope.branchId },
    include: { originalTender: true, sale: { select: { customerId: true } } },
  });
  if (!refund) throw new Error('Refund unavailable in this workspace.');
  if (refund.originalTender.type === 'LOYALTY' || !refund.sale.customerId) return null;
  if (
    refund.originalTender.saleId !== refund.saleId ||
    refund.originalTender.branchId !== scope.branchId
  )
    throw new Error('Refund tender binding mismatch.');
  const customerId = refund.sale.customerId;
  await db.$queryRaw(Prisma.sql`SELECT id FROM pharmacy_sales
    WHERE id=${refund.saleId} AND "organizationId"=${scope.organizationId}
      AND "branchId"=${scope.branchId} FOR UPDATE`);
  await lockCustomerConsent(db, scope.organizationId, customerId);
  const key = `loyalty:earn-reversal:${refund.id}`;
  const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
    where: {
      organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey: key },
    },
  });
  if (prior) {
    if (
      prior.saleId !== refund.saleId ||
      prior.customerId !== customerId ||
      prior.branchId !== scope.branchId ||
      prior.refundId !== refund.id
    )
      throw new Error('Earn reversal identity conflict.');
    return { ...prior, replayed: true };
  }
  const binding = {
    organizationId: scope.organizationId,
    branchId: scope.branchId,
    customerId,
    saleId: refund.saleId,
  };
  const earn = await db.pharmacyLoyaltyPointsEntry.findFirst({
    where: { ...binding, kind: 'EARN' },
  });
  if (!earn) return null;
  // Stops the operator's refund and names who must look, so a deliberate TRPCError.
  const rate = earn.earnEveryMinor ?? 100;
  if (earn.netPaidMinor === null || earn.points !== Math.floor(earn.netPaidMinor / rate))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Earn basis requires accounting review.',
    });
  const [refunded, reversed] = await Promise.all([
    db.pharmacyRefund.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: refund.saleId,
        originalTender: { type: { not: 'LOYALTY' } },
      },
      _sum: { amountMinor: true },
    }),
    db.pharmacyLoyaltyPointsEntry.aggregate({
      where: { ...binding, kind: 'EARN_REVERSAL' },
      _sum: { points: true },
    }),
  ]);
  const netPaidMinor = Math.max(0, earn.netPaidMinor - (refunded._sum.amountMinor ?? 0));
  const target = earn.points - Math.floor(netPaidMinor / rate);
  const points = -target - (reversed._sum.points ?? 0);
  if (points >= 0) return null;
  const entry = await db.pharmacyLoyaltyPointsEntry.create({
    data: {
      ...binding,
      kind: 'EARN_REVERSAL',
      points,
      netPaidMinor,
      tenderId: refund.originalTenderId,
      refundId: refund.id,
      actorId: scope.actorId,
      idempotencyKey: key,
    },
  });
  return { ...entry, replayed: false };
}
