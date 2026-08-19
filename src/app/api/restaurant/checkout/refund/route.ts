import {
  moneyMutationRoute,
  refundBody,
  resolveApprover,
  serializeRefundResult,
} from '@/lib/restaurant/checkout-routes';
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
