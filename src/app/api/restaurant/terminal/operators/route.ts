import { NextResponse } from 'next/server';

import { operatorHasCapability } from '@/lib/restaurant/checkout-routes';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';

/** Minimum branch-scoped directory used by a locked POS to choose an operator. */
export const GET = withTerminalAuth(async (ctx) => {
  const operators = await ctx.db.restaurantStaffProfile.findMany({
    where: {
      primaryBranchId: ctx.device.branchId,
      status: 'ACTIVE',
      credentials: {
        some: {
          type: 'PIN',
          revokedAt: null,
          OR: [{ deviceId: ctx.device.id }, { deviceId: null }],
        },
      },
    },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      displayName: true,
      user: {
        select: {
          title: true,
          organizationRole: { select: { name: true } },
        },
      },
    },
  });

  const now = new Date();
  return NextResponse.json({
    operators: await Promise.all(
      operators.map(async (operator) => ({
        staffProfileId: operator.id,
        displayName: operator.displayName,
        role: operator.user?.organizationRole?.name ?? operator.user?.title ?? 'Staff',
        canComp: await operatorHasCapability(
          ctx.db,
          operator.id,
          'orders:complimentary',
          now,
          ctx.device.branchId
        ),
        canApprove: await operatorHasCapability(
          ctx.db,
          operator.id,
          'coauth:approve',
          now,
          ctx.device.branchId
        ),
      }))
    ),
  });
});
