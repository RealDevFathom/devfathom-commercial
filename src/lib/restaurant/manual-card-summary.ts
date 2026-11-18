import { z } from 'zod';

import { type Prisma } from '@/generated/prisma/client';
import { formatMoney, sub, sum } from './money';

const totalsSchema = z.object({
  count: z.number().int().nonnegative(),
  amount: z.string(),
  tipAmount: z.string(),
  refundCount: z.number().int().nonnegative(),
  refundAmount: z.string(),
  tipRefundAmount: z.string(),
  netAmount: z.string(),
  netTipAmount: z.string(),
});
export const manualCardSummarySchema = totalsSchema.extend({
  cashiers: z.array(
    totalsSchema.extend({ staffProfileId: z.string(), displayName: z.string().nullish() })
  ),
});
export type ManualCardSummary = z.infer<typeof manualCardSummarySchema>;

export type CardCollection = {
  type: string;
  amount: Prisma.Decimal;
  tipAmount: Prisma.Decimal;
  payment?: { provider: string } | null;
  staffProfileId?: string;
  staff?: { displayName: string } | null;
};
export type CardReturn = {
  amount: Prisma.Decimal;
  tipRefundAmount?: Prisma.Decimal;
  originalTender?: Pick<CardCollection, 'type' | 'payment' | 'staffProfileId' | 'staff'>;
};

/** Collection-date payments and processing-date refunds/void reversals, attributed
 * to the original collecting cashier. Principal includes tax/service/delivery,
 * exactly as the existing CARD tender total does; tips remain separate. */
export function computeManualCardSummary(
  tenders: readonly CardCollection[],
  refunds: readonly CardReturn[]
): ManualCardSummary {
  const manual = (row: Pick<CardCollection, 'type' | 'payment'>) =>
    row.type === 'CARD' && row.payment?.provider === 'MANUAL';
  const collections = tenders.filter(manual);
  const returns = refunds.filter((row) => row.originalTender && manual(row.originalTender));
  function fold(paid: readonly CardCollection[], returned: readonly CardReturn[]) {
    const amount = sum(paid.map((row) => row.amount));
    const tipAmount = sum(paid.map((row) => row.tipAmount));
    const refundAmount = sum(returned.map((row) => row.amount));
    const tipRefundAmount = sum(returned.map((row) => row.tipRefundAmount ?? '0'));
    return {
      count: paid.length,
      amount: formatMoney(amount),
      tipAmount: formatMoney(tipAmount),
      refundCount: returned.length,
      refundAmount: formatMoney(refundAmount),
      tipRefundAmount: formatMoney(tipRefundAmount),
      netAmount: formatMoney(sub(amount, refundAmount)),
      netTipAmount: formatMoney(sub(tipAmount, tipRefundAmount)),
    };
  }
  // Names are frozen into the snapshot so a later deactivation or branch change of the
  // cashier cannot turn a historical close into raw staff ids.
  const names = new Map<string, string>();
  for (const row of [...collections, ...returns.map((r) => r.originalTender!)]) {
    if (row.staffProfileId && row.staff?.displayName) {
      names.set(row.staffProfileId, row.staff.displayName);
    }
  }
  const staffIds = new Set([
    ...collections.map((row) => row.staffProfileId!),
    ...returns.map((row) => row.originalTender!.staffProfileId!),
  ]);
  return {
    ...fold(collections, returns),
    cashiers: [...staffIds].sort().map((staffProfileId) => ({
      staffProfileId,
      displayName: names.get(staffProfileId) ?? null,
      ...fold(
        collections.filter((row) => row.staffProfileId === staffProfileId),
        returns.filter((row) => row.originalTender!.staffProfileId === staffProfileId)
      ),
    })),
  };
}
