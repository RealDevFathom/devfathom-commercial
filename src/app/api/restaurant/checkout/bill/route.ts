import { cutBills } from '@/lib/restaurant/bills';
import { billBody, moneyMutationRoute, resolveApprover } from '@/lib/restaurant/checkout-routes';
import { requireOrderInDeviceBranch } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/checkout/bill
 *
 * Cut bill(s) from an order (C4) — a plain cut, a split (by item, by seat, or a
 * fractional weighting), or a re-cut. A re-cut of an order that already has live bills
 * is a void-and-recut and carries `recut` (a reason + an inline co-authorizing manager,
 * who is verified here and must hold `coauth:approve`); the command voids the old bills
 * as new VOID records and creates a fresh set. Gated on `payments:collect`; idempotent
 * on the device-scoped money key.
 */
export const POST = moneyMutationRoute({
  schema: billBody,
  capability: 'payments:collect',
  run: async ({ ctx, data, actor, now }) => {
    await requireOrderInDeviceBranch(ctx.db, data.orderId, ctx.device.branchId);
    let recut: { reason: string; approvingStaffProfileId: string } | undefined;
    if (data.recut) {
      const approver = await resolveApprover(ctx, data.recut.approving, now);
      if (!approver.ok) return approver.response;
      recut = { reason: data.recut.reason, approvingStaffProfileId: approver.staffProfileId };
    }
    return cutBills(ctx.db, {
      orderId: data.orderId,
      branchId: ctx.device.branchId,
      split: data.split,
      recut,
      actor,
    });
  },
});
