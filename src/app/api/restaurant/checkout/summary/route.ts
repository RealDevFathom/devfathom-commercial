import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getOrderSettlementForBranch, moneyReadRoute } from '@/lib/restaurant/checkout-routes';

const query = z.object({ orderId: z.string().min(1) });

/**
 * GET /api/restaurant/checkout/summary?orderId=…
 *
 * The order's settlement state for the register (C12 read contract, consumed by L7a):
 * the derived order total, the accounted total, each live bill's status/total/receipt
 * number, any unbilled items, and whether the order is fully settled (+ the first
 * blocker). Scoped to the device's branch — a cross-branch/cross-tenant id is a 404.
 * Gated on `payments:collect`.
 */
export const GET = moneyReadRoute({
  capability: 'payments:collect',
  run: async (ctx, request) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return NextResponse.json({ error: 'A non-empty orderId query is required.' }, { status: 400 });
    }
    const summary = await getOrderSettlementForBranch(
      ctx.db,
      parsed.data.orderId,
      ctx.device.branchId
    );
    if (!summary) return NextResponse.json({ error: 'The order does not exist.' }, { status: 404 });
    return NextResponse.json(summary);
  },
});
