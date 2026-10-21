import { addItem } from '@/lib/restaurant/orders';
import { addItemBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/add-item
 *
 * Add a menu item to an open order; the L2 command snapshots name/price/modifiers
 * from the order's effective-menu publication at command time (C4).
 */
export const POST = terminalCommandRoute(
  addItemBody,
  ({ ctx, data, actor }) =>
    addItem(ctx.db, {
      orderId: data.orderId,
      menuItemId: data.menuItemId,
      quantity: data.quantity,
      course: data.course,
      seatNumber: data.seatNumber ?? null,
      modifierOptionIds: data.modifierOptionIds,
      actor,
    }),
  201
);
