import { NextResponse } from 'next/server';

import { withKdsReadAuth } from '@/lib/restaurant/terminal-auth';

/** Active staff eligible to act on the authenticated KDS device's branch. */
export const GET = withKdsReadAuth(async (ctx) => {
  const staff = await ctx.db.restaurantStaffProfile.findMany({
    where: { primaryBranchId: ctx.device.branchId, status: 'ACTIVE' },
    select: {
      id: true,
      displayName: true,
      user: { select: { title: true, organizationRole: { select: { name: true } } } },
    },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
  });
  return NextResponse.json({
    operators: staff.map((person) => ({
      staffProfileId: person.id,
      displayName: person.displayName,
      role: person.user?.organizationRole?.name ?? person.user?.title ?? 'Staff',
    })),
  });
});
