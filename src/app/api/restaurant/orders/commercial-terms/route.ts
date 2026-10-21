import { NextResponse } from 'next/server';

import { loadBranchCommercialTerms } from '@/lib/restaurant/branch-commercial-terms';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';

/**
 * GET /api/restaurant/orders/commercial-terms
 *
 * Published tax profiles and the effective service-charge rate for the
 * terminal's branch. The draft check quotes with this payload.
 */
export const GET = withTerminalAuth(async (ctx) => {
  const terms = await loadBranchCommercialTerms(ctx.db, ctx.device.branchId, new Date());
  return NextResponse.json(terms, { headers: { 'Cache-Control': 'no-store' } });
});
