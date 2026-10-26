import type { Prisma } from '@/generated/prisma/client';
type CloseSalesComponents = {
  netSales: Prisma.Decimal;
};

/** Report the authoritative, immutable net-sales total recorded by day close. */
export function reportNetSales(close: CloseSalesComponents): Prisma.Decimal {
  return close.netSales;
}
