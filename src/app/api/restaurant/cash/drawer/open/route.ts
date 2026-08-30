import {
  drawerOpenBody,
  moneyMutationRoute,
  serializeDrawerOpenResult,
} from '@/lib/restaurant/checkout-routes';
import { openDrawerSession } from '@/lib/restaurant/drawer-sessions';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';

/**
 * POST /api/restaurant/cash/drawer/open
 *
 * Open a drawer for THIS register (the authenticated device) operated by the acting
 * operator, on the branch's current business date, recording the opening float as an
 * OPENING_FLOAT movement. Rejects a second open drawer on the register. The branch is
 * the device's bound branch (never the body). Gated on `cash:open`; idempotent on the
 * money key.
 */
export const POST = moneyMutationRoute({
  schema: drawerOpenBody,
  capability: 'cash:open',
  run: async ({ ctx, data, actor, now }) => {
    const entitlements = await resolveOrganizationEntitlements(ctx.organizationId, ctx.db, now);
    return serializeDrawerOpenResult(
      await openDrawerSession(ctx.db, {
        organizationId: ctx.organizationId,
        entitlementLimits: entitlements.limits,
        branchId: ctx.device.branchId,
        openingFloat: data.openingFloat,
        actor,
        now,
      })
    );
  },
});
