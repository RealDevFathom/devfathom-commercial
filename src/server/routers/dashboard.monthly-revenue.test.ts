import { describe, expect, it } from 'vitest';
import { moneyListLabel } from '@/lib/finance/currency';
import { workspaceMonthRange } from '@/lib/timezone';
import { monthlyPaymentWhere } from './dashboard';

describe('agency dashboard monthly revenue', () => {
  it('uses the Asia/Karachi calendar-month boundary', () => {
    const range = workspaceMonthRange('Asia/Karachi', new Date('2026-10-15T12:00:00.000Z'));

    expect(range.start.toISOString()).toBe('2026-09-30T19:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-31T19:00:00.000Z');
  });

  it('formats zero and collected revenue in the tenant currency', () => {
    expect(moneyListLabel([{ currency: 'PKR', amount: 0 }])).toBe('Rs 0');
    expect(moneyListLabel([{ currency: 'PKR', amount: 125_000 }])).toBe('Rs 125,000');
  });

  it('queries paid collection rows in the current month and tenant only', () => {
    const now = new Date('2026-10-15T12:00:00Z');

    expect(monthlyPaymentWhere('agency-a', 'Asia/Karachi', now)).toEqual({
      organizationId: 'agency-a',
      paidAt: {
        gte: new Date('2026-09-30T19:00:00.000Z'),
        lt: new Date('2026-10-31T19:00:00.000Z'),
        lte: now,
      },
    });
  });
});
