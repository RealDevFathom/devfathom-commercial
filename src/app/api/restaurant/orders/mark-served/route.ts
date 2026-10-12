import { advanceItem } from '@/lib/restaurant/orders';
import { markServedBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/mark-served
 *
 * Mark a prepared item served to the guest (item PREPARED→SERVED via the L2
 * `advanceItem` command; the order aggregate is re-derived from item facts).
 */
export const POST = terminalCommandRoute(markServedBody, ({ ctx, data, actor }) =>
  advanceItem(ctx.db, { orderId: data.orderId, itemId: data.itemId, toStatus: 'SERVED', actor })
);
