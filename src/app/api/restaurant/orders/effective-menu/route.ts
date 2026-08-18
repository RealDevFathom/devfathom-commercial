import { NextResponse } from 'next/server';
import { z } from 'zod';

import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import { resolveTerminalEffectiveMenu } from '@/lib/restaurant/terminal-orders';

const query = z.object({
  channel: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
  publicationId: z.string().min(1).optional(),
  at: z.string().datetime().optional(),
});

/**
 * GET /api/restaurant/orders/effective-menu?channel=…&publicationId?=…&at?=…
 *
 * The device-authed effective-menu read for the terminal's branch/channel (C10,
 * consumed by L5b — a POS pad has no web session, so it cannot reach the M3
 * `effectiveMenu` tRPC read). Resolves the branch's live publication (or an explicit
 * one) and composes winning price + branch-timezone availability from the same M3
 * primitives (C5). 404 when no publication is resolvable for the branch/channel.
 */
export const GET = withTerminalAuth(async (ctx, request) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid query', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const menu = await resolveTerminalEffectiveMenu(ctx.db, {
    branchId: ctx.device.branchId,
    channel: parsed.data.channel,
    publicationId: parsed.data.publicationId,
    at: parsed.data.at ? new Date(parsed.data.at) : new Date(),
  });
  if (!menu) {
    return NextResponse.json(
      { error: 'No effective menu is published for this branch and channel.' },
      { status: 404 }
    );
  }
  return NextResponse.json(menu);
});
