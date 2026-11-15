import 'server-only';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { LedgerScope } from './stock-ledger';
import { earnedPoints } from './loyalty-rate';

/** Recompute each immutable earning lot, retaining its own rate and collection interval. */
export async function reverseVersionedEarns(
  db: ScopedDb,
  scope: LedgerScope,
  input: {
    refundId: string;
    saleId: string;
    customerId: string;
  }
) {
  const earns = await db.pharmacyLoyaltyPointsEntry.findMany({
    where: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: input.saleId,
      kind: 'EARN',
      programVersionId: { not: null },
    },
    include: { programVersion: true, tender: true },
  });
  const results = [];
  for (const earn of earns) {
    const program = earn.programVersion!;
    if (earn.netPaidMinor === null || earnedPoints(earn.netPaidMinor, program) !== earn.points)
      throw new Error('Earn basis requires accounting review.');
    const refunded = await db.pharmacyRefund.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: input.saleId,
        ...(earn.collectionId
          ? { originalTenderId: earn.tenderId! }
          : { originalTender: { type: { notIn: ['LOYALTY', 'CREDIT'] } } }),
      },
      _sum: { amountMinor: true },
    });
    let net = Math.max(0, earn.netPaidMinor - (refunded._sum.amountMinor ?? 0));
    if (earn.collectionId) {
      const paymentId = earn.idempotencyKey.slice('loyalty:collection:'.length);
      const payment = await db.pharmacyKhataEvent.findFirst({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          id: paymentId,
          kind: 'PAYMENT',
        },
      });
      if (!payment) throw new Error('Collection basis requires accounting review.');
      const history = await db.pharmacyKhataEvent.findMany({
        where: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          familyAccountId: payment.familyAccountId,
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      const reversedPayments = new Set(
        history.filter((row) => row.kind === 'PAYMENT_REVERSAL').map((row) => row.settlesChargeId)
      );
      let start = 0;
      let active = false;
      for (const row of history) {
        if (
          row.kind !== 'PAYMENT' ||
          row.settlesChargeId !== payment.settlesChargeId ||
          row.id.startsWith('khata-refund:') ||
          reversedPayments.has(row.id)
        )
          continue;
        if (row.id === payment.id) {
          active = true;
          break;
        }
        start += row.amountMinor;
      }
      net = active
        ? Math.min(
            earn.netPaidMinor,
            Math.max(0, earn.tender!.amountMinor - (refunded._sum.amountMinor ?? 0) - start)
          )
        : 0;
    }
    const keyPrefix = `loyalty:versioned-reversal:${earn.id}:`;
    const reversed = await db.pharmacyLoyaltyPointsEntry.aggregate({
      where: {
        organizationId: scope.organizationId,
        kind: 'EARN_REVERSAL',
        OR: [
          { idempotencyKey: { startsWith: keyPrefix } },
          { idempotencyKey: `loyalty:collection-reversal:${earn.id}` },
        ],
      },
      _sum: { points: true },
    });
    const points = earnedPoints(net, program) - earn.points - (reversed._sum.points ?? 0);
    if (points >= 0) continue;
    results.push(
      await db.pharmacyLoyaltyPointsEntry.create({
        data: {
          ...scope,
          ...input,
          kind: 'EARN_REVERSAL',
          points,
          netPaidMinor: net,
          programVersionId: earn.programVersionId,
          collectionId: earn.collectionId,
          tenderId: earn.tenderId,
          idempotencyKey: `${keyPrefix}${input.refundId}`,
        },
      })
    );
  }
  return results;
}
