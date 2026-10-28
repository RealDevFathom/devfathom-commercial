import { describe, expect, it } from 'vitest';
import { classifyBalanceSheet, type PostedAccountBalance } from './balance-sheet';

const row = (
  accountCode: string,
  closingMinor: bigint,
  currency = 'PKR'
): PostedAccountBalance => ({
  accountCode,
  currency,
  openingMinor: '0',
  debitMinor: '0',
  creditMinor: '0',
  closingMinor: closingMinor.toString(),
});

describe('classifyBalanceSheet', () => {
  it('separates opening equity, all-time current result, and operational positions', () => {
    const [sheet] = classifyBalanceSheet([
      row('CASH', 1_000n),
      row('INVENTORY', 400n),
      row('INVENTORY_IN_TRANSIT', 100n),
      row('ACCOUNTS_RECEIVABLE', 300n),
      row('SUPPLIER_CLAIM_RECEIVABLE', 50n),
      row('SALES_CLEARING', 25n),
      row('ACCOUNTS_PAYABLE', -300n),
      row('GOODS_RECEIVED_ACCRUAL', -200n),
      row('OPENING_BALANCE_EQUITY', -1_000n),
      row('SALES_REVENUE', -1_000n),
      row('SALES_DISCOUNT', 50n),
      row('COST_OF_GOODS_SOLD', 300n),
      row('OPERATING_EXPENSE', 25n),
    ]);

    expect(sheet).toMatchObject({
      assetsMinor: '1875',
      liabilitiesMinor: '500',
      openingEquityMinor: '1000',
      currentResultMinor: '625',
      reconciliationGapMinor: '-250',
      equationBalanced: false,
      reconciled: false,
    });
    expect(sheet.accounts.find((item) => item.accountCode === 'SALES_REVENUE')).toMatchObject({
      section: 'currentResult',
      normalSide: 'CREDIT',
      normalBalanceMinor: '1000',
      closingMinor: '-1000',
    });
  });

  it('nets returns, discounts, expenses, settlements, and reversals exactly once', () => {
    const [sheet] = classifyBalanceSheet([
      row('CASH', 550n),
      row('ACCOUNTS_RECEIVABLE', 50n),
      row('INVENTORY', 250n),
      row('ACCOUNTS_PAYABLE', -100n),
      row('OPENING_BALANCE_EQUITY', -200n),
      row('SALES_REVENUE', -900n), // already includes posted returns/reversals
      row('SALES_DISCOUNT', 50n),
      row('COST_OF_GOODS_SOLD', 300n),
    ]);
    expect(sheet.currentResultMinor).toBe('550');
    expect(sheet.reconciliationGapMinor).toBe('0');
    expect(sheet.reconciled).toBe(true);
  });

  it('keeps currencies separate and safely handles integer values beyond Number precision', () => {
    const huge = 9_007_199_254_740_993n;
    const sheets = classifyBalanceSheet([
      row('CASH', huge, 'USD'),
      row('OPENING_BALANCE_EQUITY', -huge, 'USD'),
      row('CASH', 5n, 'PKR'),
      row('OPENING_BALANCE_EQUITY', -5n, 'PKR'),
    ]);
    expect(sheets.map((sheet) => [sheet.currency, sheet.assetsMinor, sheet.reconciled])).toEqual([
      ['PKR', '5', true],
      ['USD', huge.toString(), true],
    ]);
  });

  it('shows nonzero unknown codes and blocks a reconciled claim without guessing policy', () => {
    const [sheet] = classifyBalanceSheet([
      row('CASH', 100n),
      row('FUTURE_WALLET', -100n),
      row('ZERO_FUTURE_CODE', 0n),
    ]);
    expect(sheet.unmappedAccountCodes).toEqual(['FUTURE_WALLET']);
    expect(sheet.equationBalanced).toBe(false);
    expect(sheet.reconciled).toBe(false);
    expect(sheet.accounts.filter((item) => item.section === 'unmapped')).toHaveLength(2);
  });

  it('returns no invented zero-currency sheet for an empty source', () => {
    expect(classifyBalanceSheet([])).toEqual([]);
  });
});
