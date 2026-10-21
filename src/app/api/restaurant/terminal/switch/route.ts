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
 * POST /api/restaurant/terminal/switch
 *
 * Change the active operator on an UNLOCKED terminal (C6). The INCOMING operator
 * must present their OWN credential — a switch is the incoming operator taking
 * over with their identity, never a manager silently replacing the actor. (A
 * manager co-authorization is the additive /co-authorize flow, which does not
 * change who is acting.)
 */
export const POST = withTerminalAuth(async (ctx, request) => {
  if (ctx.state !== 'UNLOCKED') {
    return NextResponse.json(
      { error: 'Terminal is locked; use unlock to bind the first operator.' },
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
      // 403, not 401: the incoming operator's credential is valid, they are just
      // not rostered. The outgoing operator keeps the terminal — a refused
      // handover must never leave the session bound to nobody.
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

  const previousStaffProfileId = ctx.session.activeStaffProfileId;
  const session = await bindOperator(ctx.db, ctx.session.id, staffProfileId, now);
  // C6 attribution: the INCOMING operator becomes the actor; the operator they
  // took over from is pinned for the handover trail.
  recordTerminalOperatorAudit(ctx, {
    action: 'restaurant.terminal.switch',
    actingStaffProfileId: staffProfileId,
    metadata: { previousStaffProfileId },
  });
  return NextResponse.json({
    session: {
      id: session.id,
      state: 'UNLOCKED',
      activeStaffProfileId: session.activeStaffProfileId,
    },
  });
});
