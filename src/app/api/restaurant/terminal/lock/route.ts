import { NextResponse } from 'next/server';

import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import { lockSession } from '@/lib/restaurant/terminal-session';

/**
 * POST /api/restaurant/terminal/lock
 *
 * Lock the terminal — clear the active operator while keeping the session
 * established. Locking is always permitted (no credential): stepping away must
 * never be blocked. Re-binding an operator afterwards goes through /unlock.
 */
export const POST = withTerminalAuth(async (ctx) => {
  const now = new Date();
  const session = await lockSession(ctx.db, ctx.session.id, now);
  return NextResponse.json({
    session: { id: session.id, state: 'LOCKED', activeStaffProfileId: null },
  });
});
