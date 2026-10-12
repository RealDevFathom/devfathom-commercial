import { drawerMovementBody, moneyMutationRoute } from '@/lib/restaurant/checkout-routes';
import { recordDrawerAdjustment } from '@/lib/restaurant/drawer-sessions';

/**
 * POST /api/restaurant/cash/drawer/movement
 *
 * Record a manual cash adjustment on an open drawer — a paid-in, paid-out, or drop
 * (C8). A reason is required; the movement is appended to the append-only ledger. Gated
 * on `cash:adjust`; idempotent on the device-scoped money key.
 */
export const POST = moneyMutationRoute({
  schema: drawerMovementBody,
  capability: 'cash:adjust',
  run: async ({ ctx, data, actor }) =>
    recordDrawerAdjustment(ctx.db, {
      drawerSessionId: data.drawerSessionId,
      kind: data.kind,
      amount: data.amount,
      reason: data.reason,
      actor,
    }),
});
