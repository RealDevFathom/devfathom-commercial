import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import { getOrderForBranch } from '@/lib/restaurant/terminal-orders';

const query = z.object({ orderId: z.string().min(1) });

/**
 * GET /api/restaurant/orders/detail?orderId=…
 *
 * One order's detail for the terminal, scoped to the device's branch (C10, consumed
 * by L5b). A cross-branch or cross-tenant id is indistinguishable from "not found"
 * (404) — the isolation we want.
 */
export const GET = withTerminalAuth(async (ctx, request) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: 'A non-empty orderId query is required.' }, { status: 400 });
  }
  // A missing tax profile must never make an order unreadable: getOrderForBranch
  // returns the order with tax/service left unpriced in that case, and pricing
  // fails closed only at tender/settle (#148) — this read does not 409.
  const order = await getOrderForBranch(ctx.db, parsed.data.orderId, ctx.device.branchId);
  if (!order) return NextResponse.json({ error: 'The order does not exist.' }, { status: 404 });
  return NextResponse.json(order);
});
