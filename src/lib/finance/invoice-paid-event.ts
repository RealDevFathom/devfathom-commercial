import type { PrismaClient } from '@/generated/prisma/client';
import type { EntitlementView } from '@/lib/module-catalog';
import { emitEvent } from '@/lib/webhooks';

/**
 * The one `invoice.paid` payload, shared by every surface that can settle an
 * invoice (payment, full discount, or issuing a zero-total draft). Callers emit
 * only after their own compare-and-set won the transition to PAID.
 */
export function emitInvoicePaid(
  db: PrismaClient,
  entitlements: EntitlementView,
  invoice: { id: string; total: unknown; currency: string; clientId: string }
): void {
  emitEvent(db, entitlements, 'invoice.paid', {
    invoiceId: invoice.id,
    total: Number(invoice.total),
    currency: invoice.currency,
    clientId: invoice.clientId,
  });
}
