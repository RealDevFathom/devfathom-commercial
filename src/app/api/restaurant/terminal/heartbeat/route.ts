import { NextResponse } from 'next/server';

import { deviceHealth } from '@/lib/restaurant/devices';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';

/**
 * POST /api/restaurant/terminal/heartbeat
 *
 * Liveness ping. Reaching this handler already means the device is trusted and
 * the session revalidated (C5) — `withTerminalAuth` refreshed `lastSeenAt` /
 * `lastActivityAt`. Returns the current device health, the session lock state,
 * and the SERVER time so the client can reconcile without trusting its own clock.
 */
export const POST = withTerminalAuth(async (ctx) => {
  const now = new Date();
  return NextResponse.json({
    session: {
      id: ctx.session.id,
      state: ctx.state,
      activeStaffProfileId: ctx.session.activeStaffProfileId,
    },
    device: { id: ctx.device.id, health: deviceHealth(ctx.device, now) },
    serverTime: now.toISOString(),
  });
});
