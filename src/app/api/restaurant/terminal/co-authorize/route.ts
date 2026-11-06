import { NextResponse } from 'next/server';
import { z } from 'zod';

import { readJson } from '@/lib/api-json';
import { rateLimit } from '@/lib/rate-limit';
import {
  CoAuthorizationError,
  buildCoAuthorizationRecord,
  buildAuthenticatedCoAuthorizationRecord,
  authenticateCoAuthorizationOperator,
  isSoloBranchOwner,
} from '@/lib/restaurant/co-authorization';
import { recordTerminalOperatorAudit } from '@/lib/restaurant/terminal-audit';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';

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
 * and terminal session, with a SERVER timestamp. Self-approval requires a sole
 * active branch owner and fresh PIN re-authentication, recorded in the evidence.
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

  // Validate the co-authorization invariants (distinct identities, etc.) BEFORE
  // spending a bcrypt compare, so a self-approval fails fast and cheaply.
  let record;
  try {
    const requestData = {
      actingStaffProfileId,
      approvingStaffProfileId,
      capability,
      reason,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      deviceId: ctx.device.id,
      terminalSessionId: ctx.session.id,
    };
    if (
      actingStaffProfileId === approvingStaffProfileId &&
      type === 'PIN' &&
      (await isSoloBranchOwner(ctx.db, actingStaffProfileId, ctx.device.branchId))
    ) {
      record = requestData;
    } else {
      record = buildCoAuthorizationRecord(requestData);
    }
  } catch (err) {
    if (err instanceof CoAuthorizationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const now = new Date();
  const auth = await authenticateCoAuthorizationOperator(ctx.db, {
    branchId: ctx.device.branchId,
    staffProfileId: approvingStaffProfileId,
    deviceId: ctx.device.id,
    type,
    secret,
    now,
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

  try {
    record = await buildAuthenticatedCoAuthorizationRecord(ctx.db, record);
  } catch (err) {
    if (err instanceof CoAuthorizationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
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
