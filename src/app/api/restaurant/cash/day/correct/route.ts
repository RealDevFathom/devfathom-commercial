import {
  dayCorrectBody,
  moneyMutationRoute,
  resolveApprover,
  serializeCorrectCloseResult,
} from '@/lib/restaurant/checkout-routes';
import { correctClose } from '@/lib/restaurant/daily-close';
import { recordTerminalOperatorAudit } from '@/lib/restaurant/terminal-audit';

/**
 * POST /api/restaurant/cash/day/correct
 *
 * Correct a daily close by appending a NEW close row that supersedes the current chain
 * tip, re-aggregated from the day's current rows (C9) — the immutable close is never
 * edited. Carries a reason + an inline manager co-authorization (verified here; the
 * approver must hold `coauth:approve`) as the durable audit evidence, and the REST edge
 * additionally writes the platform audit event. Gated on `cash:close`; idempotent on the
 * money key.
 */
export const POST = moneyMutationRoute({
  schema: dayCorrectBody,
  capability: 'cash:close',
  run: async ({ ctx, data, actor, now }) => {
    const approver = await resolveApprover(ctx, data.approving, now);
    if (!approver.ok) return approver.response;

    const result = await correctClose(ctx.db, {
      branchId: ctx.device.branchId,
      businessDate: data.businessDate,
      supersedesCloseId: data.supersedesCloseId,
      reason: data.reason,
      approvingStaffProfileId: approver.staffProfileId,
      actor,
    });

    recordTerminalOperatorAudit(ctx, {
      action: 'restaurant.cash.day.correct',
      actingStaffProfileId: actor.staffProfileId,
      operation: 'UPDATE',
      targetType: 'RestaurantDailyClose',
      targetId: result.dailyCloseId,
      metadata: {
        supersedesCloseId: result.supersedesCloseId,
        approvingStaffProfileId: approver.staffProfileId,
        reason: data.reason,
      },
    });

    return serializeCorrectCloseResult(result);
  },
});
