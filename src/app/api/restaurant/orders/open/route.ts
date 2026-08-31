import { openOrder } from '@/lib/restaurant/orders';
import { resolveOrganizationEntitlements } from '@/lib/entitlements';
import { openOrderBody, terminalCommandRoute } from '@/lib/restaurant/terminal-orders';

/**
 * POST /api/restaurant/orders/open
 *
 * Open an order on the terminal's bound branch (C6 — branch is transport-derived,
 * never the body). Thin transport over the L2 `openOrder` command.
 */
export const POST = terminalCommandRoute(
  openOrderBody,
  async ({ ctx, data, actor }) => {
    const entitlements = await resolveOrganizationEntitlements(ctx.organizationId, ctx.db);
    const result = await openOrder(ctx.db, {
      organizationId: ctx.organizationId,
      entitlementLimits: entitlements.limits,
      branchId: ctx.device.branchId,
      channel: data.channel,
      customerId: data.customerId ?? null,
      publicationId: data.publicationId ?? null,
      tableIds: data.tableIds,
      coverCount: data.coverCount ?? null,
      sectionId: data.sectionId ?? null,
      serverStaffProfileId: actor.staffProfileId,
      actor,
    });
    return { ...result, businessDate: result.businessDate.toISOString().slice(0, 10) };
  },
  201
);
