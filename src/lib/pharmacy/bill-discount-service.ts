import 'server-only';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  BillDiscountRefused,
  billShareHeldByTier,
  planBillDiscount,
  type BillDiscountExclusion,
  type BillDiscountPlan,
  type BillDiscountRequest,
} from './bill-discount';
import { PharmacySaleError, saleHasPaymentActivity, validateDiscount } from './sales';
import { readDiscountLimits, readMaxDiscountSettings } from './smart-discount-service';

/** DEV-956: only the owner switches the whole-bill discount on or off. */
export const BILL_DISCOUNT_CHANGE_REFUSED =
  'Only the owner can change the whole-bill discount setting.';
import type { LedgerScope } from './stock-ledger';

/** DEV-956: whether the owner has switched the whole-bill discount on. Missing reads as off. */
export async function readBillDiscountEnabled(db: ScopedDb, organizationId: string) {
  const organization = await db.organization.findFirst({
    where: { id: organizationId },
    select: { pharmacyBillDiscountEnabled: true },
  });
  return organization?.pharmacyBillDiscountEnabled === true;
}

/**
 * DEV-956: the owner's switch. The caller has verified the owner's fresh PIN; ownership is
 * re-checked here, in the write, as for the maximum discount. The organization row is locked so
 * the recorded previous value is the one replaced.
 */
export async function saveBillDiscountEnabled(
  db: ScopedDb,
  scope: Pick<LedgerScope, 'organizationId' | 'actorId'>,
  enabled: boolean
) {
  if (!(await readMaxDiscountSettings(db, scope)).canChange)
    throw new TRPCError({ code: 'FORBIDDEN', message: BILL_DISCOUNT_CHANGE_REFUSED });
  const [current] = await db.$queryRaw<Array<{ enabled: boolean }>>`
    SELECT "pharmacyBillDiscountEnabled" AS enabled FROM "organizations"
     WHERE "id" = ${scope.organizationId} FOR UPDATE`;
  if (!current) throw new PharmacySaleError('NOT_FOUND');
  const saved = await db.organization.update({
    where: { id: scope.organizationId },
    data: { pharmacyBillDiscountEnabled: enabled },
    select: { pharmacyBillDiscountEnabled: true },
  });
  return { previous: current.enabled, enabled: saved.pharmacyBillDiscountEnabled };
}

/** Server-verified approval of the discount (the same DISCOUNT approval an item discount uses). */
export type BillDiscountApproval = {
  approvedByUserId: string;
  approvalPolicy: string;
  selfApproved: boolean;
};

export type BillDiscountOutcome =
  | {
      status: 'APPLIED';
      totalMinor: number;
      previousTotalMinor: number;
      lines: { saleLineId: string; discountMinor: number }[];
      excluded: { saleLineId: string; reason: BillDiscountExclusion }[];
    }
  | {
      /** Nothing was written: the request cannot be given in full on this bill. */
      status: 'REFUSED';
      reason: 'NOTHING_TO_DISCOUNT' | 'ABOVE_LIMIT';
      requestedMinor: number;
      capacityMinor: number;
      excluded: { saleLineId: string; reason: BillDiscountExclusion }[];
    };

/**
 * DEV-956: give, change or remove (a zero request) the one whole-bill discount on an open bill.
 *
 * Runs inside the sale transaction, after the caller confirmed the approval. The sale row is
 * locked as a payment locks it, so a discount and a payment never interleave. The discount is
 * refused once the bill has taken any payment (cash, card, khata, points or a card-terminal
 * attempt), so a payment never exceeds what the bill is worth. Each line's share is checked
 * with the same rule as an item discount (owner's maximum, cost, minimum margin, approval), and
 * the database re-checks the lot snapshot at commit. The sale event records who gave it, who
 * approved it and exactly how it was shared.
 */
export async function applyBillDiscount(
  db: ScopedDb,
  scope: LedgerScope,
  input: { saleId: string; request: BillDiscountRequest; approval: BillDiscountApproval | null }
): Promise<BillDiscountOutcome> {
  if (!(await readBillDiscountEnabled(db, scope.organizationId)))
    throw new PharmacySaleError('BILL_DISCOUNT_OFF');
  // Giving or changing a discount needs a confirmed approval before the bill is even read;
  // removing one (a zero request) never does.
  const removal =
    input.request.kind === 'PERCENT' ? input.request.bps === 0 : input.request.minor === 0;
  if (!removal && !input.approval) throw new PharmacySaleError('APPROVAL_REQUIRED');
  const [locked] = await db.$queryRaw<Array<{ status: string }>>(
    Prisma.sql`SELECT status FROM pharmacy_sales WHERE id = ${input.saleId} AND "organizationId" = ${scope.organizationId} AND "branchId" = ${scope.branchId} FOR UPDATE`
  );
  if (!locked) throw new PharmacySaleError('CROSS_BRANCH_REFERENCE');
  if (locked.status !== 'OPEN') throw new PharmacySaleError('INVALID_STATE');
  if (await saleHasPaymentActivity(db, scope, input.saleId))
    throw new PharmacySaleError('BILL_DISCOUNT_AFTER_PAYMENT');
  const lines = await db.pharmacySaleLine.findMany({
    where: { organizationId: scope.organizationId, branchId: scope.branchId, saleId: input.saleId },
    include: {
      medicine: { select: { rx: true, restricted: true, controlled: true } },
      allocations: {
        orderBy: { id: 'asc' },
        include: { lot: { select: { unitCostMinor: true } } },
      },
    },
  });
  // DEV-966: a prepaid tier share priced on top of a bill share fixes the bill (a cash-on-delivery
  // bill is priced when the rider collects, before any tender): nothing is changed or removed.
  if (lines.some(billShareHeldByTier))
    throw new PharmacySaleError('BILL_DISCOUNT_LOCKED_BY_PREPAID_TIER');
  const limits = await readDiscountLimits(db, scope);
  let plan: BillDiscountPlan;
  try {
    plan = planBillDiscount(lines, input.request, limits);
  } catch (error) {
    if (!(error instanceof BillDiscountRefused)) throw error;
    if (error.reason === 'DISCOUNT_ABOVE_MAXIMUM')
      throw new PharmacySaleError('DISCOUNT_ABOVE_MAXIMUM');
    if (error.reason === 'INVALID_REQUEST' || !error.plan)
      throw new PharmacySaleError('MARGIN_GUARDRAIL');
    return {
      status: 'REFUSED',
      reason: error.reason,
      requestedMinor: error.plan.requestedMinor,
      capacityMinor: error.plan.capacityMinor,
      excluded: error.plan.excluded,
    };
  }
  const previousTotalMinor = lines.reduce((sum, line) => sum + line.billDiscountMinor, 0);
  // Removing a discount that is not there changes nothing and records nothing.
  if (removal && previousTotalMinor === 0)
    return {
      status: 'APPLIED',
      totalMinor: 0,
      previousTotalMinor,
      lines: [],
      excluded: plan.excluded,
    };
  const shareByLine = new Map(plan.shares.map((share) => [share.saleLineId, share]));
  for (const line of lines) {
    const share = shareByLine.get(line.id);
    const amount = share?.discountMinor ?? 0;
    if (amount === 0 && line.billDiscountMinor === 0) continue;
    const ownMinor = line.discountMinor - line.billDiscountMinor;
    if (amount > 0) {
      // The same rule an item discount meets, on the line's whole discount after the share.
      validateDiscount({
        regulated: line.medicine.rx || line.medicine.restricted || line.medicine.controlled,
        discountMinor: ownMinor + amount,
        grossMinor: line.grossMinor,
        costMinor: line.allocations.reduce(
          (sum, a) => sum + a.canonicalUnits * a.lot.unitCostMinor,
          0
        ),
        approvedByUserId: input.approval?.approvedByUserId,
        approvalPolicy: input.approval?.approvalPolicy,
        minMarginBps: limits.minMarginBps,
        maxDiscountBps: limits.maxDiscountBps,
      });
    }
    // A line that held only a bill share had no discount kind or approval of its own.
    await db.pharmacySaleLine.update({
      where: { organizationId_id: { organizationId: scope.organizationId, id: line.id } },
      data: {
        discountMinor: ownMinor + amount,
        billDiscountMinor: amount,
        billAllocationDiscounts: amount > 0 ? share!.allocations : Prisma.DbNull,
        discountKind: amount > 0 ? 'DISCOUNT' : null,
        approvalPolicy: amount > 0 ? input.approval!.approvalPolicy : null,
        approvedByUserId: amount > 0 ? input.approval!.approvedByUserId : null,
      },
    });
  }
  const applied = plan.shares.map((share) => ({
    saleLineId: share.saleLineId,
    discountMinor: share.discountMinor,
  }));
  await db.pharmacySaleEvent.create({
    data: {
      organizationId: scope.organizationId,
      branchId: scope.branchId,
      saleId: input.saleId,
      kind: 'BILL_DISCOUNT',
      actorId: scope.actorId,
      reason: removal ? 'REMOVED' : previousTotalMinor > 0 ? 'CHANGED' : 'GIVEN',
      payload: {
        request: input.request,
        totalMinor: plan.totalMinor,
        previousTotalMinor,
        givenByUserId: scope.actorId,
        approvedByUserId: input.approval?.approvedByUserId ?? null,
        approvalPolicy: input.approval?.approvalPolicy ?? null,
        selfApproved: input.approval?.selfApproved ?? false,
        maxDiscountBps: limits.maxDiscountBps,
        minMarginBps: limits.minMarginBps,
        lines: plan.shares.map((share) => ({
          saleLineId: share.saleLineId,
          discountMinor: share.discountMinor,
          allocations: share.allocations,
        })),
        excluded: plan.excluded,
      },
    },
  });
  return {
    status: 'APPLIED',
    totalMinor: plan.totalMinor,
    previousTotalMinor,
    lines: applied,
    excluded: plan.excluded,
  };
}
