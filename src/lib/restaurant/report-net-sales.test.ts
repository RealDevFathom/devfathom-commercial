import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import { reportNetSales } from './report-net-sales';

describe('reportNetSales', () => {
  it('uses close net sales when a refund includes tax and service charge', () => {
    const close = {
      // A 60 refund contains 50 sales, 5 tax, and 5 service charge.
      grossSales: new Prisma.Decimal('100.00'),
      netSales: new Prisma.Decimal('50.00'),
      compTotal: new Prisma.Decimal('0'),
      discountTotal: new Prisma.Decimal('0'),
      refundTotal: new Prisma.Decimal('60.00'),
    };

    expect(reportNetSales(close)).toBe(close.netSales);
    expect(reportNetSales(close).toFixed(2)).toBe('50.00');
  });

  it('normalizes a pre-WHA-1621 close whose stored total omitted refunds', () => {
    const close = {
      grossSales: new Prisma.Decimal('10'),
      netSales: new Prisma.Decimal('7'),
      compTotal: new Prisma.Decimal('2'),
      discountTotal: new Prisma.Decimal('1'),
      refundTotal: new Prisma.Decimal('3'),
    };

    expect(reportNetSales(close).toFixed(2)).toBe('4.00');
    expect(close.netSales.toFixed(2)).toBe('7.00');
  });
});
