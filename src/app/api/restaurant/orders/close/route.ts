import { closeOrder } from '@/lib/restaurant/orders';
import { closeBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/close
 *
 * Close an order. The L2 command gates the close on every item being resolved and no
 * remake outstanding (§11.1), walking SERVED→PAYMENT_PENDING→CLOSED.
 */
export const POST = terminalCommandRoute(closeBody, ({ ctx, data, actor }) =>
  closeOrder(ctx.db, { orderId: data.orderId, actor })
);
