import type { Prisma } from '@/generated/prisma/client';
import { roundMoney } from '@/lib/finance/money';

// Half-cent tolerance shared with payment recording so a sub-cent float artifact
// never leaves a covered invoice a hair short of PAID.
export const PAYMENT_EPSILON = 0.005;

/** True when collected funds cover the invoice total (within a half-cent). */
export function invoiceBalanceCovered(total: number, amountPaid: number): boolean {
  return roundMoney(amountPaid) >= roundMoney(total) - PAYMENT_EPSILON;
}

/**
 * A SENT invoice whose balance is already covered — e.g. a discount reduced the
 * total to the amount collected, or a 100% discount reduced it to zero — can never
 * receive another payment and may not be marked PAID manually. Settle it here so it
 * cannot strand in SENT with a zero balance. Compare-and-set on SENT keeps this
 * safe against a concurrent payment or status change. Returns true when this call
 * flipped the invoice to PAID.
 */
export async function settleCoveredSentInvoice(
  db: Prisma.TransactionClient,
  invoice: { id: string; total: unknown }
): Promise<boolean> {
  const total = roundMoney(Number(invoice.total));
  let amountPaid = 0;
  if (total > PAYMENT_EPSILON) {
    const paid = await db.payment.aggregate({
      where: { invoiceId: invoice.id },
      _sum: { amount: true },
    });
    amountPaid = roundMoney(Number(paid._sum.amount ?? 0));
  }
  if (!invoiceBalanceCovered(total, amountPaid)) return false;
  const changed = await db.invoice.updateMany({
    where: { id: invoice.id, status: 'SENT' },
    data: { status: 'PAID', paidAt: new Date() },
  });
  return changed.count === 1;
}
