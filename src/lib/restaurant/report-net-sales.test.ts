import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import { reportNetSales } from './report-net-sales';

describe('reportNetSales', () => {
  it('uses close net sales when a refund includes tax and service charge', () => {
    const close = {
      // A 60 refund contains 50 sales, 5 tax, and 5 service charge.
      netSales: new Prisma.Decimal('50.00'),
    };

    expect(reportNetSales(close)).toBe(close.netSales);
    expect(reportNetSales(close).toFixed(2)).toBe('50.00');
  });
});
