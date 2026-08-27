import { NextResponse } from 'next/server';

import {
  connectedReadRoute,
  customerSearchQuery,
  searchConnectedCustomers,
} from '@/lib/restaurant/terminal-customers';
import { invalidBody } from '@/lib/restaurant/terminal-orders';

/**
 * GET /api/restaurant/orders/customer/search?query=<text>&limit=<n>
 *
 * Look up a guest to attach to an order. Gated on `customers:read`; the organization comes
 * from the authenticated device (RLS), never the query. CONNECTED-ONLY — the pad must ask the
 * server every time and stores nothing.
 *
 * The projection is MASKED (`j••••@example.com`, `•••• 1234`): enough for the cashier to
 * confirm the guest in front of them, never a contactable address. A query shorter than two
 * characters is rejected and the page is capped, so this can never become a customer-book dump.
 * The query string is parsed STRICTLY — an unknown parameter is a 400, never silently ignored.
 */
export const GET = connectedReadRoute({
  capability: 'customers:read',
  run: async (ctx, request) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = customerSearchQuery.safeParse(params);
    if (!parsed.success) return invalidBody(parsed.error.issues);

    return NextResponse.json({
      customers: await searchConnectedCustomers(ctx.db, parsed.data),
    });
  },
});
