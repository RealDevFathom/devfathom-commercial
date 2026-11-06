import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client';

import { reportNetSales } from './report-net-sales';

const D = (value: string) => new Prisma.Decimal(value);

describe('reportNetSales', () => {
  const components = {
    grossSales: D('100'),
    compTotal: D('5'),
    discountTotal: D('10'),
    refundTotal: D('12'),
  };

  it('keeps current net sales when a refund includes tax or service charge', () => {
    expect(reportNetSales({ ...components, netSales: D('75') }).toString()).toBe('75');
  });

  it('normalizes legacy closes that stored sales before refunds', () => {
    expect(reportNetSales({ ...components, netSales: D('85') }).toString()).toBe('73');
  });

  it('keeps historical closes that already deducted their refund total', () => {
    expect(reportNetSales({ ...components, netSales: D('73') }).toString()).toBe('73');
  });
});
