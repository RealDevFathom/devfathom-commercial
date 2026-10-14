import { fireCourse, sendOrder } from '@/lib/restaurant/orders';
import { fireBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/fire
 *
 * Fire the order to the kitchen: the whole order (no `course`) or a single course.
 * Both move the affected HELD items to QUEUED and generate KOTs (L2 `sendOrder` /
 * `fireCourse`). Selecting the command by `course` presence is dispatch, not domain
 * logic — the L2 command owns the state machine and ticket generation.
 */
export const POST = terminalCommandRoute(fireBody, ({ ctx, data, actor }) =>
  data.course === undefined
    ? sendOrder(ctx.db, { orderId: data.orderId, actor })
    : fireCourse(ctx.db, { orderId: data.orderId, course: data.course, actor })
);
