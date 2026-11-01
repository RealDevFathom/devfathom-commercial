import { Prisma } from '@/generated/prisma/client';

import { sub, sum } from './money';

export type RefundFinancialComponent = {
  amount: Prisma.Decimal;
  taxRefundAmount: Prisma.Decimal;
  serviceChargeRefundAmount: Prisma.Decimal;
  deliveryFeeRefundAmount: Prisma.Decimal;
};

/** Canonical refund allocation shared by day close and insight reconciliation. */
export function computeRefundFinancials(refunds: readonly RefundFinancialComponent[]) {
  const taxRefunds = sum(refunds.map((refund) => refund.taxRefundAmount));
  const serviceChargeRefunds = sum(refunds.map((refund) => refund.serviceChargeRefundAmount));
  const deliveryFeeRefunds = sum(refunds.map((refund) => refund.deliveryFeeRefundAmount));
  const refundTotal = sub(sum(refunds.map((refund) => refund.amount)), deliveryFeeRefunds);
  const refundedSales = sum(
    refunds.map((refund) =>
      sub(
        sub(sub(refund.amount, refund.taxRefundAmount), refund.serviceChargeRefundAmount),
        refund.deliveryFeeRefundAmount
      )
    )
  );

  return { taxRefunds, serviceChargeRefunds, deliveryFeeRefunds, refundTotal, refundedSales };
}
