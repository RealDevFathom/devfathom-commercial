import type { Prisma } from '@/generated/prisma/client';
type CloseSalesComponents = {
  netSales: Prisma.Decimal;
};

/** The immutable close is the reporting source of truth for net sales. */
export function reportNetSales(close: CloseSalesComponents): Prisma.Decimal {
  return close.netSales;
}
