import { TRPCError } from '@trpc/server';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BalanceSheetReport } from './balance-sheet-report';

const result = {
  accounts: [
    {
      accountCode: 'CASH',
      currency: 'PKR',
      openingMinor: '0',
      debitMinor: '10000',
      creditMinor: '0',
      closingMinor: '10000',
    },
    {
      accountCode: 'OPENING_BALANCE_EQUITY',
      currency: 'PKR',
      openingMinor: '0',
      debitMinor: '0',
      creditMinor: '10000',
      closingMinor: '-10000',
    },
  ],
  source: 'finance_journal_lines',
  coverage: { basis: 'posted_entries_only', completeness: 'unknown' },
  freshness: { retrievedAt: new Date('2026-10-29T01:02:03.000Z') },
};

describe('BalanceSheetReport', () => {
  it('reads the canonical posted closing balances at the exclusive UTC cutoff and renders them', async () => {
    const financialStatements = vi.fn().mockResolvedValue(result);
    const html = renderToStaticMarkup(
      await BalanceSheetReport({
        caller: { financialStatements } as never,
        branchId: 'branch_1',
        cutoff: '2026-10-29',
      })
    );

    expect(financialStatements).toHaveBeenCalledWith({
      branchId: 'branch_1',
      from: '2026-10-28T00:00:00.000Z',
      to: '2026-10-29T00:00:00.000Z',
      page: 1,
    });
    expect(html).toContain('PKR classified balance sheet');
    expect(html).toContain('Posted equation balanced');
    expect(html).toContain('Classification complete');
    expect(html).toContain('Posted-only coverage');
    expect(html).not.toContain('Equation reconciled');
    expect(html).not.toContain('Posted equation gap');
    expect(html).not.toContain('Classification incomplete');
    expect(html).toContain('CASH');
    expect(html).toContain('100.00');
    expect(html).toContain('Source: posted accounts');
    expect(html).not.toContain('finance_journal_lines');
  });

  it('renders a balanced posted equation as classification-incomplete when nonzero unmapped accounts offset', async () => {
    const financialStatements = vi.fn().mockResolvedValue({
      ...result,
      accounts: [
        {
          accountCode: 'CUSTOMER_WALLET',
          currency: 'PKR',
          openingMinor: '0',
          debitMinor: '100',
          creditMinor: '0',
          closingMinor: '100',
        },
        {
          accountCode: 'SUPPLIER_WALLET',
          currency: 'PKR',
          openingMinor: '0',
          debitMinor: '0',
          creditMinor: '100',
          closingMinor: '-100',
        },
      ],
    });
    const html = renderToStaticMarkup(
      await BalanceSheetReport({
        caller: { financialStatements } as never,
        branchId: 'branch_1',
        cutoff: '2026-10-29',
      })
    );

    expect(html).toContain('Posted equation balanced');
    expect(html).toContain('Classification incomplete');
    expect(html).toContain('Posted-only coverage');
    expect(html).toContain(
      'Nonzero unmapped accounts block a reconciled claim: CUSTOMER_WALLET, SUPPLIER_WALLET'
    );
    expect(html).not.toContain('Classification complete');
    expect(html).not.toContain('Equation reconciled');
  });

  it('renders a nonzero posted gap without a balanced claim', async () => {
    const financialStatements = vi.fn().mockResolvedValue({
      ...result,
      accounts: [
        {
          accountCode: 'CASH',
          currency: 'PKR',
          openingMinor: '0',
          debitMinor: '100',
          creditMinor: '0',
          closingMinor: '100',
        },
      ],
    });
    const html = renderToStaticMarkup(
      await BalanceSheetReport({
        caller: { financialStatements } as never,
        branchId: 'branch_1',
        cutoff: '2026-10-29',
      })
    );

    expect(html).toContain('Posted equation gap');
    expect(html).not.toContain('Posted equation balanced');
  });

  it('renders no protected balances when the capability-checked reader denies access', async () => {
    const financialStatements = vi.fn().mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    const html = renderToStaticMarkup(
      await BalanceSheetReport({
        caller: { financialStatements } as never,
        branchId: 'branch_1',
        cutoff: '2026-10-29',
      })
    );

    expect(html).toContain('Balance sheet unavailable');
    expect(html).toContain('financial-report');
    expect(html).not.toContain('PKR classified balance sheet');
    expect(html).not.toContain('CASH');
  });
});
