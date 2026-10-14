import { NextResponse } from 'next/server';
import { z } from 'zod';

import { moneyReadRoute, serializeClosePreview } from '@/lib/restaurant/checkout-routes';
import { closePreview } from '@/lib/restaurant/daily-close';

const query = z.object({
  businessDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a "YYYY-MM-DD" business date.'),
});

/**
 * GET /api/restaurant/cash/day/preview?businessDate=YYYY-MM-DD
 *
 * The day-close preview for the register (C9/C12): the folded totals + per-tender-type
 * totals aggregated from the persisted day WITHOUT writing anything, the close-readiness
 * guards (all bills resolved, all drawers closed), and the current chain-tip close id
 * (if a close already exists, a correction — not a cut — is next). The branch is the
 * device's bound branch. Gated on `cash:close`.
 */
export const GET = moneyReadRoute({
  capability: 'cash:close',
  run: async (ctx, request) => {
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'A "YYYY-MM-DD" businessDate query is required.' },
        { status: 400 }
      );
    }
    const preview = await closePreview(ctx.db, {
      branchId: ctx.device.branchId,
      businessDate: parsed.data.businessDate,
    });
    return NextResponse.json(serializeClosePreview(preview));
  },
});
