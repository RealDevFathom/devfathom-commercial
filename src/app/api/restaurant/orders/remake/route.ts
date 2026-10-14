import { requestRemake } from '@/lib/restaurant/orders';
import { remakeBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/remake
 *
 * Request a remake of a prepared/served item (requires a reason). The original moves
 * to REMAKE_REQUESTED and a linked HELD clone is created (L2 `requestRemake`).
 */
export const POST = terminalCommandRoute(
  remakeBody,
  ({ ctx, data, actor }) =>
    requestRemake(ctx.db, {
      orderId: data.orderId,
      itemId: data.itemId,
      reason: data.reason,
      actor,
    }),
  201
);
