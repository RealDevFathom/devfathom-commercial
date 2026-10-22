import { NextResponse } from 'next/server';

/**
 * POST /api/restaurant/checkout/comp
 *
 * Comp a bill line to zero (C4): the line keeps its snapshot price, its `compAmount` is
 * set so the effective total nets to zero, and the comp records a reason + an inline
 * manager co-authorization (verified here; the approver must hold `coauth:approve`). Only
 * an OPEN bill can be comped. Gated on `orders:complimentary`; idempotent on the money key.
 */
export const POST = moneyMutationRoute({
  schema: compBody,
  capability: 'orders:complimentary',
  run: async ({ ctx, data, actor, now }) => {
    await requireBillInDeviceBranch(ctx.db, data.billId, ctx.device.branchId);
    const approver = await resolveApprover(ctx, data.approving, now);
    if (!approver.ok) return approver.response;
    return compLine(ctx.db, {
      billId: data.billId,
      branchId: ctx.device.branchId,
      billLineId: data.billLineId,
      reason: data.reason,
      approvingStaffProfileId: approver.staffProfileId,
      actor,
    });
  },
});
