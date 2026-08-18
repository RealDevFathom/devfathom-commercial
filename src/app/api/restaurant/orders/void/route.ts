import { NextResponse } from 'next/server';

import { readJson } from '@/lib/api-json';
import { voidItem } from '@/lib/restaurant/orders';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import {
  authenticateApprover,
  buildActor,
  idempotencyKeyFromRequest,
  invalidBody,
  missingIdempotencyKey,
  orderErrorResponse,
  requireActingOperator,
  voidBody,
} from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/void
 *
 * Void an item. A pre-preparation void needs only a reason. A post-preparation void
 * (FIRING/PREPARED/SERVED/REMAKE_REQUESTED) additionally requires the co-authorization
 * handshake (M2 co-authorize flow): the terminal presents an approving manager's
 * credential, which is verified here before the L2 command records the co-auth
 * evidence + wastage disposition (C6). Omitting the approver on a post-prep item is
 * rejected by the command layer (CO_AUTH_REQUIRED → 400).
 */
export const POST = withTerminalAuth(async (ctx, request) => {
  const operator = requireActingOperator(ctx);
  if (!operator.ok) return operator.response;

  const key = idempotencyKeyFromRequest(request);
  if (!key) return missingIdempotencyKey();

  const parsedJson = await readJson(request);
  if (!parsedJson.ok) return parsedJson.response;
  const parsed = voidBody.safeParse(parsedJson.data);
  if (!parsed.success) return invalidBody(parsed.error.issues);

  let approvingStaffProfileId: string | null = null;
  if (parsed.data.approving) {
    const approver = await authenticateApprover(
      ctx.db,
      ctx.device.id,
      parsed.data.approving,
      new Date()
    );
    if (!approver.ok) return approver.response;
    approvingStaffProfileId = approver.staffProfileId;
  }

  const actor = buildActor(operator.staffProfileId, ctx.device.id, key);
  try {
    const result = await voidItem(ctx.db, {
      orderId: parsed.data.orderId,
      itemId: parsed.data.itemId,
      reason: parsed.data.reason,
      wastageDisposition: parsed.data.wastageDisposition,
      approvingStaffProfileId,
      actor,
    });
    return NextResponse.json(result);
  } catch (err) {
    const response = orderErrorResponse(err);
    if (response) return response;
    throw err;
  }
});
