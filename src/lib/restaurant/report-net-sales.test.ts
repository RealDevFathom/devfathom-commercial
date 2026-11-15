import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import { computeCloseAggregate } from './daily-close';
import { reportNetSales } from './report-net-sales';

const D = (value: string | number) => new Prisma.Decimal(value);

function closeFor(refunds: Parameters<typeof computeCloseAggregate>[0]['refunds']) {
  return computeCloseAggregate({
    bills: [
      {
        status: 'SETTLED',
        subtotal: D('100'),
        deliveryFeeTotal: D('5'),
        taxTotal: D('16'),
        serviceChargeTotal: D('10'),
        compTotal: D('4'),
        discountTotal: D('6'),
        grandTotal: D('121'),
      },
    ],
    tenders: [],
    refunds,
    drawers: [],
  });
}

describe('reportNetSales', () => {
  it('matches the close netSales when a full refund includes tax, service and delivery fee', () => {
    const close = closeFor([
      {
        amount: D('121'),
        taxRefundAmount: D('16'),
        serviceChargeRefundAmount: D('10'),
        deliveryFeeRefundAmount: D('5'),
      },
    ]);
    expect(close.netSales.toString()).toBe('0');
    expect(close.refundTotal.toString()).toBe('116');
    expect(reportNetSales(close).toString()).toBe(close.netSales.toString());
  });

  it('matches the close netSales for a partial refund with tax and service components', () => {
    const close = closeFor([
      {
        amount: D('30'),
        taxRefundAmount: D('4'),
        serviceChargeRefundAmount: D('2.5'),
        deliveryFeeRefundAmount: D('0'),
      },
    ]);
    expect(close.netSales.toString()).toBe('66.5');
    expect(reportNetSales(close).toString()).toBe('66.5');
  });

  it('keeps closes without refunds unchanged', () => {
    const close = closeFor([]);
    expect(reportNetSales(close).toString()).toBe('90');
  });

  it('normalizes legacy closes whose netSales predates refund deduction', () => {
    expect(
      reportNetSales({
        grossSales: D('100'),
        netSales: D('90'),
        compTotal: D('4'),
        discountTotal: D('6'),
        refundTotal: D('20'),
      }).toString()
    ).toBe('70');
  });

  it('keeps the recorded value of pre-#405 closes that deducted the whole refund amount', () => {
    expect(
      reportNetSales({
        grossSales: D('100'),
        netSales: D('70'),
        compTotal: D('4'),
        discountTotal: D('6'),
        refundTotal: D('20'),
      }).toString()
    ).toBe('70');
  });
});
