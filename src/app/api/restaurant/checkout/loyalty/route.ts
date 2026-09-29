import { NextResponse } from 'next/server';

import { connectedMutationRoute, connectedReadRoute } from '@/lib/restaurant/terminal-customers';
import {
  getLoyaltySnapshotForBranch,
  loyaltyErrorResponse,
  loyaltyRedeemBody,
  loyaltySnapshotQuery,
  redeemForBranch,
  serializeRedeemResult,
} from '@/lib/restaurant/terminal-loyalty';
import { invalidBody } from '@/lib/restaurant/terminal-orders';

/**
 * GET /api/restaurant/checkout/loyalty?billId=<id>
 *
 * The redemption panel's read model for one bill: the guest's balance, the money-per-point of
 * the program in force now, what is still outstanding on the bill, and the largest point count
 * that fits. READ-ONLY, so it is gated on `customers:read` (every cashier who can attach a guest
 * at checkout can see their balance) rather than `loyalty:redeem`, which only the POST requires.
 * Scoped to the device's own branch (a bill elsewhere is a 404). Ids only — no guest PII crosses
 * to the pad.
 *
 * `maxRedeemablePoints` is a DISPLAY affordance, not authorization: the POST re-derives and
 * re-checks every bound under row locks, so a pad that ignores it still cannot over-redeem.
 */
export const GET = connectedReadRoute({
  capability: 'customers:read',
  mapError: loyaltyErrorResponse,
  run: async (ctx, request) => {
    const params = Object.fromEntries(new URL(request.url).searchParams);
    const parsed = loyaltySnapshotQuery.safeParse(params);
    if (!parsed.success) return invalidBody(parsed.error.issues);

    const snapshot = await getLoyaltySnapshotForBranch(
      ctx.db,
      parsed.data.billId,
      ctx.device.branchId
    );
    if (!snapshot) return NextResponse.json({ error: 'Bill does not exist.' }, { status: 404 });
    return NextResponse.json(snapshot);
  },
});

/**
 * POST /api/restaurant/checkout/loyalty
 *
 * Redeem whole points against an OPEN bill in the device's own branch, taking their value off
 * the bill as a discount. Gated on `loyalty:redeem`; idempotent on the device-scoped
 * `Idempotency-Key` header, which the M8 command records on the ledger entry so a replay
 * returns the original result and appends no second entry (and never double-discounts).
 *
 * The client sends POINTS, never money: the value is derived server-side from the effective
 * program's `redemptionValue`, so a pad cannot propose its own discount. Insufficient balance,
 * a bill belonging to another guest, a closed bill and a redemption larger than the outstanding
 * balance are all refused by the command layer under row locks.
 */
export const POST = connectedMutationRoute({
  schema: loyaltyRedeemBody,
  capability: 'loyalty:redeem',
  requireIdempotencyKey: true,
  mapError: loyaltyErrorResponse,
  run: async ({ ctx, data, staffProfileId, idempotencyKey, now }) => {
    const result = await redeemForBranch(ctx.db, {
      billId: data.billId,
      accountId: data.accountId,
      points: data.points,
      branchId: ctx.device.branchId,
      actorId: staffProfileId,
      idempotencyKey,
      at: now,
    });
    if (!result) return NextResponse.json({ error: 'Bill does not exist.' }, { status: 404 });
    return serializeRedeemResult(result);
  },
});
