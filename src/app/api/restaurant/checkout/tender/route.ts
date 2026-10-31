import { applyTender } from '@/lib/restaurant/tenders';
import {
  moneyMutationRoute,
  serializeTenderResult,
  tenderBody,
} from '@/lib/restaurant/checkout-routes';

/**
 * POST /api/restaurant/checkout/tender
 *
 * Apply one tender to a bill — cash (with change from `cashReceived`), a card settled
 * through the MOCK adapter SALE path (optional tip), or an OTHER seam (optional tip).
 * When the tender brings the bill to full coverage the command settles it and allocates
 * its receipt number, atomically and exactly once. Gated on `payments:collect`;
 * idempotent on the device-scoped money key (a replay returns the original result and
 * creates no second tender/payment/movement/receipt).
 */
export const POST = moneyMutationRoute({
  schema: tenderBody,
  capability: 'payments:collect',
  obscureBillId: (data) => data.billId,
  run: async ({ ctx, data, actor, now }) =>
    serializeTenderResult(
      await applyTender(ctx.db, {
        billId: data.billId,
        tender: data.tender,
        actor,
        branchId: ctx.device.branchId,
        now,
      })
    ),
});
