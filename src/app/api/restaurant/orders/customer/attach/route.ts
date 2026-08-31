import { NextResponse } from 'next/server';

import {
  attachCustomerForBranch,
  connectedMutationRoute,
  customerAttachBody,
  customerErrorResponse,
} from '@/lib/restaurant/terminal-customers';

/**
 * POST /api/restaurant/orders/customer/attach
 *
 * Attach a guest to an OPEN order so the bill can earn and redeem loyalty. Gated on
 * `customers:manage`; the organization comes from the device (RLS) and the branch from
 * `ctx.device.branchId` — the body carries only the two object ids, never a scope.
 *
 * An order outside the device's own branch answers 404, indistinguishable from one that does
 * not exist, so the route cannot be used to probe another branch's order book. The M8 command
 * owns the rest: it refuses a non-OPEN order and an order that already belongs to a different
 * guest (409), and re-attaching the same guest is a no-op, so a retry needs no idempotency key.
 */
export const POST = connectedMutationRoute({
  schema: customerAttachBody,
  capability: 'customers:manage',
  mapError: customerErrorResponse,
  run: async ({ ctx, data }) => {
    const attached = await attachCustomerForBranch(ctx.db, {
      orderId: data.orderId,
      customerId: data.customerId,
      branchId: ctx.device.branchId,
    });
    if (!attached) return NextResponse.json({ error: 'Order does not exist.' }, { status: 404 });
    return attached;
  },
});
