import { openOrder } from '@/lib/restaurant/orders';
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
    const result = await openOrder(ctx.db, {
      branchId: ctx.device.branchId,
      channel: data.channel,
      publicationId: data.publicationId ?? null,
      tableIds: data.tableIds,
      coverCount: data.coverCount ?? null,
      sectionId: data.sectionId ?? null,
      serverStaffProfileId: data.serverStaffProfileId ?? null,
      actor,
    });
    return { ...result, businessDate: result.businessDate.toISOString().slice(0, 10) };
  },
  201
);
