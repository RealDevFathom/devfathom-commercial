import type { Prisma } from '@/generated/prisma/client';
import { sub } from './money';

type CloseSalesComponents = {
  grossSales: Prisma.Decimal;
  compTotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  refundTotal: Prisma.Decimal;
};

/** Current reporting formula, derived from immutable close components.
 * Historical netSales may predate refunds; never subtract from that versioned value.
 * This read boundary leaves the recorded close and its tender/ledger totals intact.
 */
export function reportNetSales(close: CloseSalesComponents): Prisma.Decimal {
  return sub(sub(sub(close.grossSales, close.compTotal), close.discountTotal), close.refundTotal);
}
