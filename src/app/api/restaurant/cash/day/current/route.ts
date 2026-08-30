import { NextResponse } from 'next/server';

import { resolveBusinessDate } from '@/lib/restaurant/business-date';
import { moneyReadRoute } from '@/lib/restaurant/checkout-routes';
import { getCurrentDrawerSession } from '@/lib/restaurant/drawer-sessions';

/** Authoritative eligible close date: unresolved closed day, open drawer, then branch calendar. */
export const GET = moneyReadRoute({
  capability: 'cash:close',
  run: async (ctx) => {
    const representedDates = await ctx.db.restaurantDailyClose.findMany({
      where: { branchId: ctx.device.branchId },
      select: { businessDate: true },
      distinct: ['businessDate'],
    });
    const pendingDrawer = await ctx.db.restaurantDrawerSession.findFirst({
      where: {
        branchId: ctx.device.branchId,
        status: 'CLOSED',
        businessDate: { notIn: representedDates.map((close) => close.businessDate) },
      },
      orderBy: [{ businessDate: 'desc' }, { closedAt: 'desc' }],
      select: { businessDate: true },
    });
    if (pendingDrawer) {
      return NextResponse.json({
        businessDate: pendingDrawer.businessDate.toISOString().slice(0, 10),
      });
    }
    const drawer = await getCurrentDrawerSession(ctx.db, {
      branchId: ctx.device.branchId,
      deviceId: ctx.device.id,
    });
    if (drawer) {
      return NextResponse.json({ businessDate: drawer.businessDate.toISOString().slice(0, 10) });
    }
    const branch = await ctx.db.restaurantBranch.findUnique({
      where: { id: ctx.device.branchId },
      select: { timezone: true, businessDayCutoff: true },
    });
    if (!branch) return NextResponse.json({ error: 'Branch not found.' }, { status: 404 });
    return NextResponse.json({
      businessDate: resolveBusinessDate(new Date(), branch.timezone, branch.businessDayCutoff),
    });
  },
});
