import { NextResponse } from 'next/server';

import { moneyReadRoute } from '@/lib/restaurant/checkout-routes';
import { getCurrentDrawerSession } from '@/lib/restaurant/drawer-sessions';

/** The durable open drawer for this authenticated device and its bound branch. */
export const GET = moneyReadRoute({
  capability: 'cash:open',
  run: async (ctx) => {
    const drawer = await getCurrentDrawerSession(ctx.db, {
      branchId: ctx.device.branchId,
      deviceId: ctx.device.id,
    });
    return NextResponse.json(
      drawer
        ? {
            drawerSessionId: drawer.drawerSessionId,
            businessDate: drawer.businessDate.toISOString().slice(0, 10),
            openingFloat: drawer.openingFloat.toString(),
            expectedCash: drawer.expectedCash.toFixed(2),
            movements: drawer.movements.map((movement) => ({
              ...movement,
              amount: movement.amount.toFixed(2),
              createdAt: movement.createdAt.toISOString(),
            })),
            replayed: false,
          }
        : null
    );
  },
});
