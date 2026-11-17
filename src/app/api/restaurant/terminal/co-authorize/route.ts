import { recordOwnerPinReauthentication } from '@/lib/restaurant/owner-reauthentication';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readJson } from '@/lib/api-json';
import { rateLimit } from '@/lib/rate-limit';
import {
  CoAuthorizationError,
  buildCoAuthorizationRecord,
} from '@/lib/restaurant/co-authorization';
import { recordTerminalOperatorAudit } from '@/lib/restaurant/terminal-audit';
import { authenticateOperator, withTerminalAuth } from '@/lib/restaurant/terminal-auth';

const bodySchema = z.object({
  approvingStaffProfileId: z.string().min(1),
  type: z.enum(['PIN', 'BADGE']),
  secret: z.string().min(1),
  capability: z.string().min(1),
  reason: z.string().min(1),
  targetType: z.string().min(1).optional(),
  targetId: z.string().min(1).optional(),
});

/**
 * POST /api/restaurant/terminal/co-authorize
 *
 * A manager co-authorizes a sensitive action taken by the terminal's ACTING
 * operator (C6/C7). The approving manager proves their own credential; approval
 * ADDS their identity to the evidence record and never changes who is acting.
 * The record pins acting + approving staff, capability, target, reason, device
 * and terminal session, with a SERVER timestamp. A self-approval (approver ==
 * actor) requires a fresh PIN and server-verified sole-owner evidence.
 */
export const POST = withTerminalAuth(async (ctx, request) => {
  const actingStaffProfileId = ctx.session.activeStaffProfileId;
  if (ctx.state !== 'UNLOCKED' || !actingStaffProfileId) {
    return NextResponse.json(
      { error: 'No acting operator: unlock the terminal before requesting co-authorization.' },
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
  const { approvingStaffProfileId, type, secret, capability, reason, targetType, targetId } =
    parsed.data;

  const burst = await rateLimit(
    `terminal:cred:${ctx.device.id}:${approvingStaffProfileId}`,
    10,
    60_000
  );
  if (!burst.ok) {
    return NextResponse.json(
      { error: 'Too many attempts' },
      { status: 429, headers: { 'Retry-After': String(burst.retryAfter) } }
    );
  }

  const now = new Date();
  const auth = await authenticateOperator(ctx.db, {
    staffProfileId: approvingStaffProfileId,
    deviceId: ctx.device.id,
    type,
    secret,
    branchId: ctx.device.branchId,
    now,
    approval: {
      action: 'restaurant.terminal.coAuthorize',
      requestedByStaffProfileId: actingStaffProfileId,
    },
  });
  if (!auth.ok) {
    if (auth.reason === 'LOCKED') {
      return NextResponse.json(
        { error: "Approving manager's credential is temporarily locked." },
        { status: 423, headers: { 'Retry-After': String(Math.ceil(auth.retryAfterMs / 1000)) } }
      );
    }
    return NextResponse.json({ error: 'Invalid approving credential.' }, { status: 401 });
  }

  if (type === 'PIN')
    await recordOwnerPinReauthentication(ctx.db, approvingStaffProfileId, ctx.device.branchId);

  // Ordinary approval requires distinct identities. The sole-owner exception
  // is available only after the PIN proof above has been verified on the server.
  let record;
  try {
    record = buildCoAuthorizationRecord({
      actingStaffProfileId,
      approvingStaffProfileId,
      capability,
      reason,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      deviceId: ctx.device.id,
      terminalSessionId: ctx.session.id,
    });
  } catch (err) {
    if (err instanceof CoAuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const created = await ctx.db.restaurantCoAuthorization.create({ data: record });
  // C7 attribution: the actor stays the ACTING operator (approval never changes
  // who acts); the approving manager and the evidence are pinned in metadata.
  recordTerminalOperatorAudit(ctx, {
    action: 'restaurant.terminal.co-authorize',
    actingStaffProfileId: record.actingStaffProfileId,
    operation: 'EXECUTE',
    targetType: record.targetType,
    targetId: record.targetId,
    metadata: {
      coAuthorizationId: created.id,
      approvingStaffProfileId: record.approvingStaffProfileId,
      capability: record.capability,
      reason: record.reason,
      approvalMode:
        record.actingStaffProfileId === record.approvingStaffProfileId
          ? 'OWNER_PIN_REAUTHENTICATION'
          : 'SECOND_OPERATOR',
    },
  });
  return NextResponse.json(
    {
      coAuthorization: {
        id: created.id,
        capability: created.capability,
        actingStaffProfileId: created.actingStaffProfileId,
        approvingStaffProfileId: created.approvingStaffProfileId,
        targetType: created.targetType,
        targetId: created.targetId,
        createdAt: created.createdAt.toISOString(),
      },
    },
    { status: 201 }
  );
});
