import { NextResponse } from 'next/server';
import { reverseCompLine } from '@/lib/restaurant/bills';
import {
  moneyMutationRoute,
  requireBillInDeviceBranch,
  resolveApprover,
  reverseCompBody,
} from '@/lib/restaurant/checkout-routes';

/** Reverse an audited line comp, including on an OPEN bill with partial tenders. */
export const POST = moneyMutationRoute({
  schema: reverseCompBody,
  capability: 'orders:complimentary',
  run: async ({ ctx, data, actor, now }) => {
    if (!(await requireBillInDeviceBranch(ctx.db, data.billId, ctx.device.branchId))) {
      return NextResponse.json({ error: 'The bill does not exist.' }, { status: 404 });
    }
    const approver = await resolveApprover(ctx, data.approving, now);
    if (!approver.ok) return approver.response;
    return reverseCompLine(ctx.db, {
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
