import {
  drawerCloseBody,
  moneyMutationRoute,
  serializeDrawerCloseResult,
} from '@/lib/restaurant/checkout-routes';
import { closeDrawerSession } from '@/lib/restaurant/drawer-sessions';

/**
 * POST /api/restaurant/cash/drawer/close
 *
 * Close an open drawer: fold the ledger to derive expected cash, record the counted cash
 * + variance ONCE, append a CLOSING_COUNT movement, and flip OPEN→CLOSED (C8). A second
 * close on an already-closed session is rejected (counts are write-once). Gated on
 * `cash:close`; idempotent on the money key.
 */
export const POST = moneyMutationRoute({
  schema: drawerCloseBody,
  capability: 'cash:close',
  run: async ({ ctx, data, actor, now }) =>
    serializeDrawerCloseResult(
      await closeDrawerSession(ctx.db, {
        drawerSessionId: data.drawerSessionId,
        countedCash: data.countedCash,
        actor,
        now,
      })
    ),
});
