import { NextResponse } from 'next/server';

import { compLine } from '@/lib/restaurant/bills';
import {
  compBody,
  moneyMutationRoute,
  requireBillInDeviceBranch,
  resolveApprover,
} from '@/lib/restaurant/checkout-routes';

/** Test-only transport for the retained comp domain. The public MVP endpoint denies
 * every request; this adapter preserves authorization and transaction regression coverage
 * without exposing that domain through an application route. */
export const POST = moneyMutationRoute({
  schema: compBody,
  capability: 'orders:complimentary',
  run: async ({ ctx, data, actor, now }) => {
    if (!(await requireBillInDeviceBranch(ctx.db, data.billId, ctx.device.branchId))) {
      return NextResponse.json({ error: 'The bill does not exist.' }, { status: 404 });
    }
    const approver = await resolveApprover(ctx, data.approving, now);
    if (!approver.ok) return approver.response;
    return compLine(ctx.db, {
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
