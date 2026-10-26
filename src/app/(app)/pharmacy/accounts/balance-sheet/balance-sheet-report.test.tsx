import { renderToStaticMarkup } from 'react-dom/server';
import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';
import { BalanceSheetReport } from './balance-sheet-report';

describe('BalanceSheetReport', () => {
  it('renders traceable revenue and expense account balances alongside the derived result', async () => {
    const financialStatements = vi.fn().mockResolvedValue({
      accounts: [
        { accountCode: 'CASH', currency: 'PKR', closingMinor: '5000' },
        { accountCode: 'SALES_REVENUE', currency: 'PKR', closingMinor: '-7000' },
        { accountCode: 'SALES_DISCOUNT', currency: 'PKR', closingMinor: '2000' },
      ],
      freshness: { retrievedAt: new Date('2026-10-26T12:00:00Z') },
    });
    const caller = { financialStatements } as Parameters<typeof BalanceSheetReport>[0]['caller'];
    const cutoff = new Date('2026-10-26T12:00:00Z');

    const html = renderToStaticMarkup(
      await BalanceSheetReport({ caller, branchId: 'branch-1', cutoff })
    );

    expect(financialStatements).toHaveBeenCalledWith({
      branchId: 'branch-1',
      from: '2026-10-25T12:00:00.000Z',
      to: '2026-10-26T12:00:00.000Z',
      page: 1,
    });
    expect(html).toContain('Revenue accounts');
    expect(html).toContain('Sales revenue');
    expect(html).toContain('(SALES_REVENUE)');
    expect(html).toContain('PKR 70.00 CREDIT');
    expect(html).toContain('raw Dr−Cr PKR -70.00');
    expect(html).toContain('Expense accounts');
    expect(html).toContain('Sales discounts and returns');
    expect(html).toContain('Derived cumulative posted current result');
    expect(html).toContain('PKR 50.00');
  });

  it('does not expose financial output when the canonical source denies access', async () => {
    const caller = {
      financialStatements: vi
        .fn()
        .mockRejectedValue(new TRPCError({ code: 'FORBIDDEN', message: 'denied' })),
    } as unknown as Parameters<typeof BalanceSheetReport>[0]['caller'];

    const html = renderToStaticMarkup(
      await BalanceSheetReport({
        caller,
        branchId: 'branch-1',
        cutoff: new Date('2026-10-26T12:00:00Z'),
      })
    );

    expect(html).toContain('No financial balances were returned.');
    expect(html).not.toContain('classified balance sheet');
    expect(html).not.toContain('Sales revenue');
  });
});
