import { Prisma } from '@/generated/prisma/client';
import {
  moneyReadRoute,
  moneyMutationRoute,
  refundBody,
  resolveApprover,
  serializeRefundResult,
} from '@/lib/restaurant/checkout-routes';

const money = (value: Prisma.Decimal) => value.toString();

/** Recent settled tenders for this terminal's active branch. Raw identifiers are
 * transport-only selector values; the terminal renders receipt/order labels. */
export const GET = moneyReadRoute({
  capability: 'payments:refund',
  run: async (ctx) => {
    const tenders = await ctx.db.restaurantTender.findMany({
      where: { bill: { branchId: ctx.device.branchId, status: 'SETTLED' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      select: {
        id: true,
        type: true,
        amount: true,
        tipAmount: true,
        createdAt: true,
        bill: {
          select: {
            receiptNumber: true,
            order: { select: { orderNumber: true } },
          },
        },
        refunds: { select: { amount: true, tipRefundAmount: true } },
      },
    });
    return Response.json({
      tenders: tenders.map((tender) => {
        const refunded = tender.refunds.reduce(
          (sum, row) => sum.plus(row.amount),
          new Prisma.Decimal(0)
        );
        const tipRefunded = tender.refunds.reduce(
          (sum, row) => sum.plus(row.tipRefundAmount),
          new Prisma.Decimal(0)
        );
        return {
          tenderId: tender.id,
          orderNumber: tender.bill.order.orderNumber,
          receiptNumber: tender.bill.receiptNumber,
          type: tender.type,
          paidAmount: money(tender.amount),
          refundedAmount: money(refunded),
          remainingAmount: money(tender.amount.minus(refunded)),
          tipPaidAmount: money(tender.tipAmount),
          tipRefundedAmount: money(tipRefunded),
          tipRemainingAmount: money(tender.tipAmount.minus(tipRefunded)),
          paidAt: tender.createdAt.toISOString(),
        };
      }),
    });
  },
});
import { refundTender } from '@/lib/restaurant/refunds';

/**
 * POST /api/restaurant/checkout/refund
 *
 * Refund (or same-day fully reverse) an original tender as a NEW append-only record
 * (C7) — never an edit. Carries a reason + an inline manager co-authorization (verified
 * here; the approver must hold `coauth:approve`); a cash refund posts a CASH_REFUND
 * drawer movement, a card refund runs the MOCK adapter REFUND/VOID path. Refund + tip
 * caps are enforced by the command. Gated on `payments:refund`; idempotent on the money
 * key.
 */
export const POST = moneyMutationRoute({
  schema: refundBody,
  capability: 'payments:refund',
  run: async ({ ctx, data, actor, now }) => {
    const approver = await resolveApprover(ctx, data.approving, now);
    if (!approver.ok) return approver.response;
    return serializeRefundResult(
      await refundTender(ctx.db, {
        originalTenderId: data.originalTenderId,
        amount: data.amount,
        tipRefundAmount: data.tipRefundAmount,
        kind: data.kind,
        reason: data.reason,
        approvingStaffProfileId: approver.staffProfileId,
        actor,
        now,
      })
    );
  },
});
