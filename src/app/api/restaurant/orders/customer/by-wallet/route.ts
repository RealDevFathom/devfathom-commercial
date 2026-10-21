import { NextResponse } from 'next/server';

import {
  connectedReadRoute,
  resolveWalletScan,
  walletScanQuery,
} from '@/lib/restaurant/terminal-customers';
import { invalidBody } from '@/lib/restaurant/terminal-orders';

const NOT_FOUND = { error: 'Wallet alias was not found.' };

/** Connected-only, zero-PII wallet scan for the existing attach/redeem flow. */
export const GET = connectedReadRoute({
  capability: 'customers:read',
  moduleKey: 'restaurant-loyalty',
  run: async (ctx, request) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = walletScanQuery.safeParse(params);
    if (!parsed.success) return invalidBody(parsed.error.issues);

    const result = await resolveWalletScan(ctx.db, parsed.data.code.slice('DFW1:'.length));
    return result ? NextResponse.json(result) : NextResponse.json(NOT_FOUND, { status: 404 });
  },
});
