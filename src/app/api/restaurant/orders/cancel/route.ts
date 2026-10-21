import { NextResponse } from 'next/server';

import { readJson } from '@/lib/api-json';
import { operatorHasCapability } from '@/lib/restaurant/checkout-routes';
import { cancelOrder } from '@/lib/restaurant/orders';
import { withTerminalAuth } from '@/lib/restaurant/terminal-auth';
import {
  authenticateApprover,
  buildActor,
  cancelBody,
  idempotencyKeyFromRequest,
  invalidBody,
  missingIdempotencyKey,
  orderErrorResponse,
  requireActingOperator,
  requireOrderTakingCapability,
  requireOrderInDeviceBranch,
} from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/cancel
 *
 * Cancel an order. The L2 command voids every still-active item first (§11.1). If any
 * active item is post-preparation, the co-authorization handshake is required: the
 * terminal presents an approving manager's credential, verified here before the
 * command records the co-auth + wastage disposition (C6). Omitting the approver when
 * prepared items remain is rejected by the command layer (CO_AUTH_REQUIRED → 400).
 */
export const POST = withTerminalAuth(async (ctx, request) => {
  const operator = requireActingOperator(ctx);
  if (!operator.ok) return operator.response;
  const capabilityError = await requireOrderTakingCapability(ctx, operator.staffProfileId);
  if (capabilityError) return capabilityError;

  const key = idempotencyKeyFromRequest(request);
  if (!key) return missingIdempotencyKey();

  const parsedJson = await readJson(request);
  if (!parsedJson.ok) return parsedJson.response;
  const parsed = cancelBody.safeParse(parsedJson.data);
  if (!parsed.success) return invalidBody(parsed.error.issues);

  try {
    await requireOrderInDeviceBranch(ctx.db, parsed.data.orderId, ctx.device.branchId);
  } catch (err) {
    const response = orderErrorResponse(err);
    if (response) return response;
    throw err;
  }

  let approvingStaffProfileId: string | null = null;
  if (parsed.data.approving) {
    const now = new Date();
    const approver = await authenticateApprover(
      ctx.db,
      ctx.device.id,
      ctx.device.branchId,
      parsed.data.approving,
      now
    );
    if (!approver.ok) return approver.response;
    if (
      !(await operatorHasCapability(
        ctx.db,
        approver.staffProfileId,
        'coauth:approve',
        now,
        ctx.device.branchId
      ))
    ) {
      return NextResponse.json(
        { error: 'The approving manager lacks the "coauth:approve" capability.' },
        { status: 403 }
      );
    }
    approvingStaffProfileId = approver.staffProfileId;
  }

  try {
    await requireOrderInDeviceBranch(ctx.db, parsed.data.orderId, ctx.device.branchId);
  } catch (err) {
    const response = orderErrorResponse(err);
    if (response) return response;
    throw err;
  }

  const actor = buildActor(operator.staffProfileId, ctx.device.id, key);
  try {
    const result = await cancelOrder(ctx.db, {
      orderId: parsed.data.orderId,
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
