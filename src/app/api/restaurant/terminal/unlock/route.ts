import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readJson } from '@/lib/api-json';
import { rateLimit } from '@/lib/rate-limit';
import { recordTerminalOperatorAudit } from '@/lib/restaurant/terminal-audit';
import { describeShiftDenial } from '@/lib/restaurant/shifts';
import { authenticateOperator, withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import { bindOperator } from '@/lib/restaurant/terminal-session';

const bodySchema = z.object({
  staffProfileId: z.string().min(1),
  type: z.enum(['PIN', 'BADGE']),
  secret: z.string().min(1),
});

/**
 * POST /api/restaurant/terminal/unlock
 *
 * Bind the first operator to a LOCKED terminal by verifying that operator's own
 * credential (C4/C6). A cheap per-device+operator burst limit fronts the durable
 * lockout: the burst limit caps floods, the durable per-row counters are the
 * authoritative brute-force control (BUILD-ASSUMPTIONS). Already-unlocked
 * terminals must use /switch.
 */
export const POST = withTerminalAuth(async (ctx, request) => {
  if (ctx.state !== 'LOCKED') {
    return NextResponse.json(
      { error: 'Terminal is already unlocked; use switch to change operator.' },
      { status: 409 }
    );
  }

  const json = await readJson(request);
  if (!json.ok) return json.response;
  const parsed = bodySchema.safeParse(json.data);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { staffProfileId, type, secret } = parsed.data;

  const burst = await rateLimit(`terminal:cred:${ctx.device.id}:${staffProfileId}`, 10, 60_000);
  if (!burst.ok) {
    return NextResponse.json(
      { error: 'Too many attempts' },
      { status: 429, headers: { 'Retry-After': String(burst.retryAfter) } }
    );
  }

  const now = new Date();
  const auth = await authenticateOperator(ctx.db, {
    staffProfileId,
    deviceId: ctx.device.id,
    branchId: ctx.device.branchId,
    type,
    secret,
    now,
  });
  if (!auth.ok) {
    if (auth.reason === 'LOCKED') {
      return NextResponse.json(
        { error: 'Credential is temporarily locked after repeated failures.' },
        { status: 423, headers: { 'Retry-After': String(Math.ceil(auth.retryAfterMs / 1000)) } }
      );
    }
    if (auth.reason === 'NO_ACTIVE_SHIFT') {
      // 403, not 401: the credential is valid, the operator is simply not
      // rostered right now. The structured reason lets the terminal render the
      // real state (and the branch-local next start) instead of "wrong PIN".
      return NextResponse.json(
        {
          error: describeShiftDenial(auth.shiftReason),
          reason: auth.shiftReason,
          nextShiftStartsAt: auth.nextShiftStartsAt?.toISOString() ?? null,
        },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: 'Invalid operator credential.' }, { status: 401 });
  }

  const session = await bindOperator(ctx.db, ctx.session.id, staffProfileId, now);
  // C6/C7 attribution: the operator who just bound to the terminal is the actor.
  recordTerminalOperatorAudit(ctx, {
    action: 'restaurant.terminal.unlock',
    actingStaffProfileId: staffProfileId,
  });
  return NextResponse.json({
    session: {
      id: session.id,
      state: 'UNLOCKED',
      activeStaffProfileId: session.activeStaffProfileId,
    },
  });
});
