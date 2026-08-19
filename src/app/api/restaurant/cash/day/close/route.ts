import {
  dayCloseBody,
  moneyMutationRoute,
  serializeCutCloseResult,
} from '@/lib/restaurant/checkout-routes';
import { cutClose } from '@/lib/restaurant/daily-close';

/**
 * POST /api/restaurant/cash/day/close
 *
 * Cut the FIRST daily close for the device's branch on a business date (C9): guard that
 * every bill is SETTLED/VOID and every drawer CLOSED and that no close exists yet, then
 * persist the immutable snapshot + its per-tender-type children in ONE transaction. Gated
 * on `cash:close`; idempotent on the money key. A subsequent change is a correction, not
 * a re-close.
 */
export const POST = moneyMutationRoute({
  schema: dayCloseBody,
  capability: 'cash:close',
  run: async ({ ctx, data, actor }) =>
    serializeCutCloseResult(
      await cutClose(ctx.db, {
        branchId: ctx.device.branchId,
        businessDate: data.businessDate,
        actor,
      })
    ),
});
