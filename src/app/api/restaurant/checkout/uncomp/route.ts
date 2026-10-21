import { uncompLine } from '@/lib/restaurant/bills';
import {
  moneyMutationRoute,
  requireBillInDeviceBranch,
  resolveApprover,
  uncompBody,
} from '@/lib/restaurant/checkout-routes';

/** Reverse a mistaken comp before any tender is recorded. */
export const POST = moneyMutationRoute({
  schema: uncompBody,
  capability: 'orders:complimentary',
  run: async ({ ctx, data, actor, now }) => {
    await requireBillInDeviceBranch(ctx.db, data.billId, ctx.device.branchId);
    const approver = await resolveApprover(ctx, data.approving, now);
    if (!approver.ok) return approver.response;
    return uncompLine(ctx.db, {
      billId: data.billId,
      branchId: ctx.device.branchId,
      billLineId: data.billLineId,
      reason: data.reason,
      approvingStaffProfileId: approver.staffProfileId,
      terminalSessionId: ctx.session.id,
      actor,
    });
  },
});
