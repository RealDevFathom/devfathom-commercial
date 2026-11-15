import 'server-only';

import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { earnedPointsFor, pointsForNetPaid } from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { lockCustomerConsent } from './consent-writer';
import { readExpiredPointsByLot } from './loyalty-expiry';
import { khataEarnRetained } from './loyalty-khata-earn';
import type { LedgerScope } from './stock-ledger';

/**
 * DEV-764: points of an earned lot that already expired are gone from the balance. A refund
 * reverses the earn, but never takes those points a second time. Only the part of a lot the
 * refund reverses counts: expiry on a lot (or part of a lot) the refund leaves in place does
 * not reduce what is taken back.
 */
const EXPIRED_FROM_LOT = {
  closedBy: { where: { kind: 'EXPIRY' as const }, select: { points: true } },
};
type LotWithExpiry = { id?: string; closedBy?: ReadonlyArray<{ points: number }> };
/**
 * Points expired out of a lot. `byLot` (from the ledger replay) also counts points a refund or
 * void returned into the lot after it was closed and that were then expired at once, so the
 * answer does not depend on when the sweep ran. Without such entries the lot's own expiry is
 * the whole story.
 */
function expiredFrom(lot: LotWithExpiry, byLot: ReadonlyMap<string, number> | null) {
  if (byLot && lot.id !== undefined) return byLot.get(lot.id) ?? 0;
  return (lot.closedBy ?? []).reduce((total, row) => total + Math.max(0, -row.points), 0);
}
/** Points to take back from lots, each reversing `reversed[i]` of its points. */
function reversalAfterExpiry(
  lots: readonly LotWithExpiry[],
  reversed: readonly number[],
  byLot: ReadonlyMap<string, number> | null
) {
  return lots.reduce((sum, lot, index) => {
    const take = Math.max(0, reversed[index] ?? 0);
    return sum + take - Math.min(take, expiredFrom(lot, byLot));
  }, 0);
}

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
    include: EXPIRED_FROM_LOT,
  });
  // DEV-746: a versioned sale never earned on its CREDIT tender; that money earns, and is
  // reversed, per collection. Sales from before versioning keep their original reversal.
  const legacy = Boolean(earn) && !earn!.programVersionId;
  if (refund.originalTender.type === 'CREDIT' && !legacy)
    return reverseKhataEarnedPoints(db, scope, refund, binding, key);
  if (!earn) return null;
  const rule = earn.programVersionId
    ? await db.pharmacyLoyaltyProgramVersion.findFirst({
        where: { organizationId: scope.organizationId, id: earn.programVersionId },
      })
    : null;
  const pointsFor = (netPaidMinor: number) =>
    rule ? earnedPointsFor(netPaidMinor, rule) : pointsForNetPaid(netPaidMinor);
  // Stops the operator's refund and names who must look, so a deliberate TRPCError.
  if (
    earn.netPaidMinor === null ||
    (earn.programVersionId && !rule) ||
    earn.points !== pointsFor(earn.netPaidMinor)
  )
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
        originalTender: { type: legacy ? { not: 'LOYALTY' } : { notIn: ['LOYALTY', 'CREDIT'] } },
      },
      _sum: { amountMinor: true },
    }),
    db.pharmacyLoyaltyPointsEntry.aggregate({
      where: legacy
        ? { ...binding, kind: 'EARN_REVERSAL' }
        : { ...binding, kind: 'EARN_REVERSAL', tender: { type: { not: 'CREDIT' } } },
      _sum: { points: true },
    }),
  ]);
  const netPaidMinor = Math.max(0, earn.netPaidMinor - (refunded._sum.amountMinor ?? 0));
  const byLot = await readExpiredPointsByLot(
    db,
    { organizationId: scope.organizationId, branchId: scope.branchId, customerId },
    new Date()
  );
  const target = reversalAfterExpiry([earn], [earn.points - pointsFor(netPaidMinor)], byLot);
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

/**
 * DEV-746: a refund of a CREDIT tender takes back the points its khata collections earned
 * on money that is no longer owed. Each collection keeps its own program version.
 */
async function reverseKhataEarnedPoints(
  db: ScopedDb,
  scope: LedgerScope,
  refund: { id: string; originalTenderId: string; originalTender: { amountMinor: number } },
  binding: { organizationId: string; branchId: string; customerId: string; saleId: string },
  idempotencyKey: string
) {
  const earns = await db.pharmacyLoyaltyPointsEntry.findMany({
    where: { ...binding, tenderId: refund.originalTenderId, kind: 'KHATA_EARN' },
    include: { programVersion: true, ...EXPIRED_FROM_LOT },
    orderBy: [{ earnStartMinor: 'asc' }, { id: 'asc' }],
  });
  if (!earns.length) return null;
  if (earns.some((earn) => !earn.programVersion || earn.netPaidMinor === null))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Earn basis requires accounting review.',
    });
  const [refunded, reversed] = await Promise.all([
    db.pharmacyRefund.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        originalTenderId: refund.originalTenderId,
      },
      _sum: { amountMinor: true },
    }),
    db.pharmacyLoyaltyPointsEntry.aggregate({
      where: { ...binding, tenderId: refund.originalTenderId, kind: 'EARN_REVERSAL' },
      _sum: { points: true },
    }),
  ]);
  const capMinor = Math.max(
    0,
    refund.originalTender.amountMinor - (refunded._sum.amountMinor ?? 0)
  );
  const totals = khataEarnRetained(
    earns.map((earn) => ({
      points: earn.points,
      netPaidMinor: earn.netPaidMinor!,
      earnStartMinor: earn.earnStartMinor ?? 0,
      rule: earn.programVersion!,
    })),
    capMinor
  );
  const byLot = await readExpiredPointsByLot(
    db,
    {
      organizationId: binding.organizationId,
      branchId: binding.branchId,
      customerId: binding.customerId,
    },
    new Date()
  );
  const target = reversalAfterExpiry(
    earns,
    earns.map((earn, index) => earn.points - (totals.retainedByEarn[index] ?? 0)),
    byLot
  );
  const points = -target - (reversed._sum.points ?? 0);
  if (points >= 0) return null;
  const entry = await db.pharmacyLoyaltyPointsEntry.create({
    data: {
      ...binding,
      kind: 'EARN_REVERSAL',
      points,
      netPaidMinor: totals.retainedMinor,
      tenderId: refund.originalTenderId,
      refundId: refund.id,
      actorId: scope.actorId,
      idempotencyKey,
    },
  });
  return { ...entry, replayed: false };
}
