import { holdCourse } from '@/lib/restaurant/orders';
import { holdBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/hold
 *
 * Recall a course that was sent but has not started cooking (its QUEUED items move
 * back to HELD). Thin transport over the L2 `holdCourse` command.
 */
export const POST = terminalCommandRoute(holdBody, ({ ctx, data, actor }) =>
  holdCourse(ctx.db, { orderId: data.orderId, course: data.course, actor })
);
