import { NextResponse } from 'next/server';
import { requireKdsStation } from '@/lib/restaurant/kds';
import { staffHasCapability } from '@/lib/restaurant/job-roles';

import { withKdsAuth } from '@/lib/restaurant/kds-auth';

/** Active staff eligible to act on the authenticated KDS device's branch. */
export const GET = withKdsAuth(async (ctx) => {
  const station = requireKdsStation(ctx.device);
  if (!station.ok) return station.response;
  const staff = await ctx.db.restaurantStaffProfile.findMany({
    where: { primaryBranchId: ctx.device.branchId, status: 'ACTIVE' },
    select: {
      id: true,
      displayName: true,
      user: { select: { title: true, organizationRole: { select: { name: true } } } },
    },
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
  });
  const eligible = (
    await Promise.all(
      staff.map(async (person) =>
        (await staffHasCapability(ctx.db, person.id, ctx.device.branchId, 'kitchen:operate'))
          ? person
          : null
      )
    )
  ).filter((person) => person !== null);
  return NextResponse.json({
    operators: eligible.map((person) => ({
      staffProfileId: person.id,
      displayName: person.displayName,
      role: person.user?.organizationRole?.name ?? person.user?.title ?? 'Staff',
    })),
  });
});
