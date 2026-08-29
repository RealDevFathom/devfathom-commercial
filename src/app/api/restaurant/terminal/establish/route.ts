import { NextResponse } from 'next/server';

import { withDeviceAuth } from '@/lib/restaurant/terminal-auth';
import { establishSession, terminalSessionState } from '@/lib/restaurant/terminal-session';

/**
 * POST /api/restaurant/terminal/establish
 *
 * A trusted device opens a terminal session. Authenticates with the device
 * secret only (no session exists yet). The session starts LOCKED; an operator is
 * bound later via /unlock. The raw session token is returned ONCE — the terminal
 * must store it and present it on every subsequent call as `X-Terminal-Session`.
 */
export const POST = withDeviceAuth(async (ctx) => {
  const now = new Date();
  const branch = await ctx.db.restaurantBranch.findUniqueOrThrow({
    where: { id: ctx.device.branchId },
    select: { name: true },
  });
  const { session, token } = await establishSession(ctx.db, ctx.device.id, now);
  return NextResponse.json(
    {
      sessionToken: token,
      session: {
        id: session.id,
        state: terminalSessionState(session),
        establishedAt: session.establishedAt.toISOString(),
      },
      device: { id: ctx.device.id, branchName: branch.name },
    },
    { status: 201 }
  );
});
