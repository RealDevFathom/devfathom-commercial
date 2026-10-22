import { NextResponse } from 'next/server';

import { can, subjectFromSession } from '@/lib/abac';
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
    const operator = await ctx.db.restaurantStaffProfile.findFirst({
      where: {
        id: actor.staffProfileId,
        status: 'ACTIVE',
        OR: [
          { primaryBranchId: ctx.device.branchId },
          { jobRoles: { some: { branchId: ctx.device.branchId } } },
          { directCapabilityGrants: { some: { branchId: ctx.device.branchId } } },
        ],
      },
      select: { user: { select: { id: true, role: true, department: true, status: true } } },
    });
    if (
      !operator?.user ||
      !(await can(subjectFromSession(operator.user), 'orders:complimentary', undefined, {
        db: ctx.db,
        now,
      }))
    ) {
      return NextResponse.json(
        { error: 'This operator lacks the "orders:complimentary" capability.' },
        { status: 403 }
      );
    }
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
