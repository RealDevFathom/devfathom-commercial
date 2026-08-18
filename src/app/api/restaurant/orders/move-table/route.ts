import { moveTable } from '@/lib/restaurant/orders';
import { moveTableBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/move-table
 *
 * Move an order from one table to another within the branch (L2 `moveTable`
 * deactivates the source link and creates a MOVE link on the target).
 */
export const POST = terminalCommandRoute(moveTableBody, ({ ctx, data, actor }) =>
  moveTable(ctx.db, {
    orderId: data.orderId,
    fromTableId: data.fromTableId,
    toTableId: data.toTableId,
    actor,
  })
);
