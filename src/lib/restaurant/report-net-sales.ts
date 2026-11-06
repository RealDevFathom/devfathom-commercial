import type { Prisma } from '@/generated/prisma/client';
import { sub } from './money';

type CloseSalesComponents = {
  grossSales: Prisma.Decimal;
  netSales: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  refundTotal: Prisma.Decimal;
};

/** Normalize the one identifiable legacy close shape without replacing current close math.
 *
 * Older closes stored sales before refunds in `netSales`; for those rows the value exactly
 * matches gross less comps and discounts, so reports still need to deduct `refundTotal`.
 * Current closes already store the sales-only refund deduction (which cannot be reconstructed
 * from the persisted aggregate components), and are therefore the source of truth otherwise.
 */
export function reportNetSales(close: CloseSalesComponents): Prisma.Decimal {
  const salesBeforeRefunds = sub(sub(close.grossSales, close.compTotal), close.discountTotal);
  return close.netSales.equals(salesBeforeRefunds)
    ? sub(salesBeforeRefunds, close.refundTotal)
    : close.netSales;
}
