import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import { reportNetSales } from './report-net-sales';

describe('reportNetSales', () => {
  it('uses authoritative net sales rather than subtracting tax-inclusive refundTotal again', () => {
    expect(reportNetSales({ netSales: new Prisma.Decimal('50') }).toString()).toBe('50');
  });
});
