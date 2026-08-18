import { NextResponse } from 'next/server';

import { recordTerminalOperatorAudit } from '@/lib/restaurant/terminal-audit';
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
  // Capture the acting operator BEFORE the lock clears it, so the lock is
  // attributed to whoever was signed in (C6). Locking an already-locked terminal
  // has no acting operator, so there is nothing to attribute.
  const actingStaffProfileId = ctx.session.activeStaffProfileId;
  const session = await lockSession(ctx.db, ctx.session.id, now);
  if (actingStaffProfileId) {
    recordTerminalOperatorAudit(ctx, {
      action: 'restaurant.terminal.lock',
      actingStaffProfileId,
    });
  }
  return NextResponse.json({
    session: { id: session.id, state: 'LOCKED', activeStaffProfileId: null },
  });
});
