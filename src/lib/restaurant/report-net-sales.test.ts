import { describe, expect, it } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

import { reportNetSales } from './report-net-sales';

describe('reportNetSales', () => {
  it('uses the close net sales without subtracting refunded tax or service charge again', () => {
    expect(reportNetSales({ netSales: new Prisma.Decimal('82.00') }).toString()).toBe('82');
  });
});
