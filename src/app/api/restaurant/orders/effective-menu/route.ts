import { NextResponse } from 'next/server';

import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import {
  effectiveMenuETag,
  effectiveMenuQuery,
  effectiveMenuVersion,
  ifNoneMatchSatisfied,
  resolveTerminalEffectiveMenu,
} from '@/lib/restaurant/terminal-orders';

/**
 * GET /api/restaurant/orders/effective-menu?channel=…&publicationId?=…&at?=…
 *
 * The device-authed effective-menu read for the terminal's branch/channel (C10,
 * consumed by L5b — a POS pad has no web session, so it cannot reach the M3
 * `effectiveMenu` tRPC read). Resolves the branch's live publication (or an explicit
 * one) and composes winning price + branch-timezone availability from the same M3
 * primitives (C5). 404 when no publication is resolvable for the branch/channel.
 *
 * M9-L1 adds the catalog-coherence contract this route is the authority for:
 * a deterministic `version` derived from the COMPLETE resolved payload, served as a
 * strong `ETag`, with `If-None-Match` answered 304 so a terminal refreshing every 30
 * seconds keeps the catalog it already cached instead of re-downloading it. The
 * query is now STRICT (C7): an unknown search parameter is a 400. The response is
 * `no-store` — the version, not an HTTP cache, is what the terminal reasons about.
 */
export const GET = withTerminalAuth(async (ctx, request) => {
  const parsed = effectiveMenuQuery.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
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

  // The version hashes the resolved menu itself; it is then added to the body so the
  // terminal can persist it without recomputing a server-side digest.
  const version = effectiveMenuVersion(menu);
  const etag = effectiveMenuETag(version);
  const headers = { ETag: etag, 'Cache-Control': 'no-store' };

  if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, { status: 304, headers });
  }
  return NextResponse.json({ ...menu, version }, { headers });
});
