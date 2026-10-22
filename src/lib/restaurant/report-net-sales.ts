import type { Prisma } from '@/generated/prisma/client';
type CloseSalesComponents = {
  netSales: Prisma.Decimal;
};

/** Return the authoritative close value. Refund totals also contain refunded tax and
 * service charge, so reconstructing net sales from refundTotal would subtract those
 * components from pre-tax sales a second time.
 */
export function reportNetSales(close: CloseSalesComponents): Prisma.Decimal {
  return close.netSales;
}
