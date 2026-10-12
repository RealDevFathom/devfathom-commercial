import { NextResponse } from 'next/server';

import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import { listOpenOrdersForBranch } from '@/lib/restaurant/terminal-orders';

/**
 * GET /api/restaurant/orders/open-orders
 *
 * The terminal's open-orders list for its bound branch (C10, consumed by L5b).
 * Branch-scoped to the device; RLS scopes it to the device's organization. Any
 * valid device session may read it (no acting operator required — it is not an
 * attributable mutation).
 */
export const GET = withTerminalAuth(async (ctx) =>
  NextResponse.json(await listOpenOrdersForBranch(ctx.db, ctx.device.branchId))
);
