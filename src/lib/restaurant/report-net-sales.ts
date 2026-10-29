import type { Prisma } from '@/generated/prisma/client';
import { sub } from './money';

type CloseSalesComponents = {
  grossSales: Prisma.Decimal;
  netSales: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  refundTotal: Prisma.Decimal;
};

/**
 * Read net sales across both immutable close formulas.
 *
 * Pre-WHA-1621 closes omitted refunds from their stored netSales. That legacy
 * value is identifiable because it is exactly gross less comps and discounts.
 * Newer closes store the component-aware value and remain authoritative (their
 * refundTotal can also contain refunded tax/service charges).
 */
export function reportNetSales(close: CloseSalesComponents): Prisma.Decimal {
  const legacyNetSales = sub(sub(close.grossSales, close.compTotal), close.discountTotal);
  if (!close.refundTotal.isZero() && close.netSales.equals(legacyNetSales)) {
    return sub(legacyNetSales, close.refundTotal);
  }
  return close.netSales;
}
