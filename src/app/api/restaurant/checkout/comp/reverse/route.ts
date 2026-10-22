import { reverseComp } from '@/lib/restaurant/bills';
import {
  moneyMutationRoute,
  requireBillInDeviceBranch,
  resolveApprover,
  reverseCompBody,
} from '@/lib/restaurant/checkout-routes';

/** Reverse a mistaken comp, including on an OPEN bill with partial tenders. */
export const POST = moneyMutationRoute({
  schema: reverseCompBody,
  capability: 'payments:collect',
  run: async ({ ctx, data, actor, now }) => {
    await requireBillInDeviceBranch(ctx.db, data.billId, ctx.device.branchId);
    const approver = await resolveApprover(ctx, data.approving, now);
    if (!approver.ok) return approver.response;
    return reverseComp(ctx.db, {
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
