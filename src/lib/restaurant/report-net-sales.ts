import type { Prisma } from '@/generated/prisma/client';
import { sub } from './money';

type CloseSalesComponents = {
  grossSales: Prisma.Decimal;
  netSales: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  refundTotal: Prisma.Decimal;
};

/** Reporting net sales for one immutable daily close.
 * Current closes persist netSales with only the SALES part of refunds deducted
 * (refunded tax, service charge and delivery fee stay out of net sales), so the
 * recorded value is authoritative. `refundTotal` still carries refunded tax and
 * service charge and must never be subtracted from a current close.
 * Legacy closes stored netSales before any refund deduction (net equals
 * gross − comp − discount); only those are normalized by subtracting refundTotal.
 * Known limitation: a current close whose refunds have no sales part at all (only
 * tax/service) also matches that shape and is normalized the legacy way.
 * This read boundary leaves the recorded close and its tender/ledger totals intact.
 */
export function reportNetSales(close: CloseSalesComponents): Prisma.Decimal {
  const salesBeforeRefunds = sub(sub(close.grossSales, close.compTotal), close.discountTotal);
  if (!close.netSales.equals(salesBeforeRefunds)) return close.netSales;
  return sub(salesBeforeRefunds, close.refundTotal);
}
