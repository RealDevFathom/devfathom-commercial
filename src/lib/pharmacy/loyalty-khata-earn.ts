import 'server-only';

import { earnedPointsForTranche, loyaltyExpiresAt } from '@/lib/commerce/loyalty-arithmetic';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import { currentLoyaltyProgram, hasLoyaltyEarningConsent } from './loyalty-program';
import type { LedgerScope } from './stock-ledger';

/** A khata charge made by a CREDIT tender carries this id (see the khata tender route). */
const CHARGE_PREFIX = 'khata:';
/** Debt written off by a refund of the CREDIT tender: not money collected, never earns. */
const REFUND_PAYMENT_PREFIX = 'khata-refund:';

export const khataEarnKey = (paymentEventId: string) => `loyalty:khata-earn:${paymentEventId}`;

/**
 * DEV-746: a khata (credit) sale earns points when its debt is paid, not when it is sold.
 *
 * Called only by the counter repayment service, in its transaction, with the PAYMENT
 * events that service just wrote while settling the debt (so the family account lock is
 * held and settlement has happened exactly once). Each payment earns for the customer on
 * the original sale, at the program version in force now, on the money collected against
 * that charge. Keyed by the payment event, so it can never earn twice for one payment.
 */
export async function earnKhataCollectionPoints(
  db: ScopedDb,
  scope: LedgerScope,
  payments: ReadonlyArray<{ id: string; settlesChargeId: string | null; amountMinor: number }>
) {
  const eligible = payments.filter((payment) => payment.settlesChargeId?.startsWith(CHARGE_PREFIX));
  if (!eligible.length) return [];
  // No rate set by the owner means nothing is earned; no default rate is assumed.
  const program = await currentLoyaltyProgram(db, scope.organizationId);
  if (!program) return [];
  // DEV-764: the owner's switch. Off means khata purchases earn nothing, even once paid.
  if (program.khataEarns === false) return [];
  const earned = [];
  for (const payment of eligible) {
    if (!payment.settlesChargeId) continue;
    const idempotencyKey = khataEarnKey(payment.id);
    const prior = await db.pharmacyLoyaltyPointsEntry.findUnique({
      where: {
        organizationId_idempotencyKey: { organizationId: scope.organizationId, idempotencyKey },
      },
    });
    if (prior) continue;
    const tender = await db.pharmacyTender.findFirst({
      where: {
        id: payment.settlesChargeId.slice(CHARGE_PREFIX.length),
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        type: 'CREDIT',
      },
      select: {
        id: true,
        saleId: true,
        amountMinor: true,
        sale: { select: { customerId: true } },
        refunds: { select: { amountMinor: true } },
      },
    });
    const customerId = tender?.sale.customerId;
    if (!tender || !customerId) continue;
    // Sales from before versioning already earned on their CREDIT tender at sale time.
    const legacyEarn = await db.pharmacyLoyaltyPointsEntry.findFirst({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        saleId: tender.saleId,
        kind: 'EARN',
        programVersionId: null,
      },
      select: { id: true },
    });
    if (legacyEarn) continue;
    const collectedBefore = await db.pharmacyKhataEvent.aggregate({
      where: {
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        kind: 'PAYMENT',
        settlesChargeId: payment.settlesChargeId,
        id: { not: payment.id },
        NOT: { id: { startsWith: REFUND_PAYMENT_PREFIX } },
      },
      _sum: { amountMinor: true },
    });
    // Only money owed on the tender after refunds can earn.
    const capMinor = Math.max(
      0,
      tender.amountMinor - tender.refunds.reduce((sum, row) => sum + row.amountMinor, 0)
    );
    const startMinor = Math.min(collectedBefore._sum.amountMinor ?? 0, capMinor);
    const basisMinor = Math.min(startMinor + payment.amountMinor, capMinor) - startMinor;
    if (basisMinor <= 0) continue;
    const points = earnedPointsForTranche(startMinor, basisMinor, program);
    if (points === 0) continue;
    if (!(await hasLoyaltyEarningConsent(db, scope.organizationId, customerId))) continue;
    earned.push(
      await db.pharmacyLoyaltyPointsEntry.create({
        data: {
          organizationId: scope.organizationId,
          branchId: scope.branchId,
          customerId,
          saleId: tender.saleId,
          tenderId: tender.id,
          kind: 'KHATA_EARN',
          points,
          netPaidMinor: basisMinor,
          earnStartMinor: startMinor,
          programVersionId: program.id,
          // DEV-764: the lot lasts as long as the program in force when it was earned says.
          expiresAt: loyaltyExpiresAt(new Date(), program.expiryDays),
          actorId: scope.actorId,
          idempotencyKey,
        },
      })
    );
  }
  return earned;
}

/**
 * Points a refund of a CREDIT tender takes back from what its collections earned: the
 * collected money above what is still owed after refunds stops earning. Each collection is
 * repriced only with its own program version, so a later rate change never rewrites it.
 */
export function khataEarnRetained(
  earns: ReadonlyArray<{
    points: number;
    netPaidMinor: number;
    earnStartMinor: number;
    rule: { earnMode: string; earnPoints: number; perSpendMinor: number };
  }>,
  capMinor: number
) {
  let retainedPoints = 0;
  let retainedMinor = 0;
  let earnedPoints = 0;
  // DEV-764: points each collection keeps, in input order, so a caller can tell which lots
  // the refund actually reverses.
  const retainedByEarn: number[] = [];
  for (const earn of earns) {
    const kept = Math.min(Math.max(capMinor - earn.earnStartMinor, 0), earn.netPaidMinor);
    const keptPoints = Math.min(
      earn.points,
      earnedPointsForTranche(earn.earnStartMinor, kept, earn.rule)
    );
    earnedPoints += earn.points;
    retainedMinor += kept;
    retainedPoints += keptPoints;
    retainedByEarn.push(keptPoints);
  }
  return { earnedPoints, retainedPoints, retainedMinor, retainedByEarn };
}
