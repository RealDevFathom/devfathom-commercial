import { describe, expect, it } from 'vitest';
import { FinanceAccountCode } from '@/generated/prisma/enums';
import { profitAndLossClassification, projectProfitAndLoss } from './profit-loss';

const movement = (
  accountCode: string,
  debit: number | bigint,
  credit: number | bigint,
  currency = 'PKR'
) => ({
  accountCode,
  currency,
  debit: BigInt(debit),
  credit: BigInt(credit),
});
const fixture = [
  movement('SALES_REVENUE', 0, 10000),
  movement('SALES_DISCOUNT', 1000, 0),
  movement('COST_OF_GOODS_SOLD', 6000, 0),
  movement('OPERATING_EXPENSE', 1000, 0),
];

describe('classified posted-ledger profit and loss', () => {
  it('returns net revenue, gross profit and net result for the acceptance fixture', () => {
    expect(projectProfitAndLoss(fixture)[0]).toMatchObject({
      currency: 'PKR',
      netRevenueMinor: '9000',
      grossProfitMinor: '3000',
      postedExpensesMinor: '1000',
      netProfitMinor: '2000',
      unmappedAccounts: [],
    });
  });

  it('classifies every canonical account explicitly', () => {
    expect(Object.keys(profitAndLossClassification).sort()).toEqual(
      Object.values(FinanceAccountCode).sort()
    );
  });

  it('excludes every balance-sheet code from income and expenses', () => {
    const balances = Object.entries(profitAndLossClassification)
      .filter(([, classification]) => classification === 'balance_sheet')
      .map(([code]) => movement(code, 12345, 6789));
    expect(projectProfitAndLoss(balances)).toEqual([]);
    expect(projectProfitAndLoss([...balances, ...fixture])).toEqual(projectProfitAndLoss(fixture));
  });

  it('shows unknown activity by currency, including net-zero movements, without guessing its treatment', () => {
    const result = projectProfitAndLoss([
      ...fixture,
      movement('NEW_EXPENSE', 500, 100),
      movement('NEW_REVENUE', 0, 900, 'USD'),
      movement('NEW_REVERSED_EXPENSE', 300, 300),
      movement('NEW_UNUSED', 0, 0),
    ]);
    expect(result[0]).toMatchObject({
      netProfitMinor: '2000',
      unmappedAccounts: [
        { accountCode: 'NEW_EXPENSE', debitMinor: '500', creditMinor: '100', amountMinor: '400' },
        {
          accountCode: 'NEW_REVERSED_EXPENSE',
          debitMinor: '300',
          creditMinor: '300',
          amountMinor: '0',
        },
      ],
    });
    expect(result[1]).toMatchObject({
      currency: 'USD',
      netProfitMinor: '0',
      unmappedAccounts: [{ accountCode: 'NEW_REVENUE', amountMinor: '-900' }],
    });
  });

  it('retains reversal signs and nets every posted expense or gain', () => {
    const reversed = fixture.map((row) => ({ ...row, debit: row.credit, credit: row.debit }));
    expect(projectProfitAndLoss(reversed)[0]).toMatchObject({
      netRevenueMinor: '-9000',
      grossProfitMinor: '-3000',
      netProfitMinor: '-2000',
    });
    const expenses = Object.entries(profitAndLossClassification)
      .filter(([, classification]) => classification === 'expense')
      .map(([code]) => movement(code, 0, 100));
    expect(projectProfitAndLoss([...fixture, ...expenses])[0]).toMatchObject({
      postedExpensesMinor: '500',
      netProfitMinor: '2500',
    });
    expect(projectProfitAndLoss([...fixture, ...reversed])[0]?.netProfitMinor).toBe('0');
  });

  it('uses exact integers for every subtotal and keeps currencies independent', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1000);
    const result = projectProfitAndLoss([
      movement('SALES_REVENUE', 0, huge),
      movement('SALES_DISCOUNT', 101, 0),
      movement('COST_OF_GOODS_SOLD', 201, 0),
      movement('OPERATING_EXPENSE', 301, 0),
      movement('OPERATING_EXPENSE', 500, 0, 'USD'),
    ]);
    expect(result[0]).toMatchObject({
      netRevenueMinor: (huge - BigInt(101)).toString(),
      grossProfitMinor: (huge - BigInt(302)).toString(),
      netProfitMinor: (huge - BigInt(603)).toString(),
    });
    expect(result[1]).toMatchObject({ currency: 'USD', netProfitMinor: '-500' });
  });
});
