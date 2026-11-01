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
      row('CASH', BigInt('1000')),
      row('INVENTORY', BigInt('400')),
      row('INVENTORY_IN_TRANSIT', BigInt('100')),
      row('ACCOUNTS_RECEIVABLE', BigInt('300')),
      row('SUPPLIER_CLAIM_RECEIVABLE', BigInt('50')),
      row('SALES_CLEARING', BigInt('25')),
      row('ACCOUNTS_PAYABLE', BigInt('-300')),
      row('GOODS_RECEIVED_ACCRUAL', BigInt('-200')),
      row('OPENING_BALANCE_EQUITY', BigInt('-1000')),
      row('SALES_REVENUE', BigInt('-1000')),
      row('SALES_DISCOUNT', BigInt('50')),
      row('COST_OF_GOODS_SOLD', BigInt('300')),
      row('OPERATING_EXPENSE', BigInt('25')),
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
      row('CASH', BigInt('550')),
      row('ACCOUNTS_RECEIVABLE', BigInt('50')),
      row('INVENTORY', BigInt('250')),
      row('ACCOUNTS_PAYABLE', BigInt('-100')),
      row('OPENING_BALANCE_EQUITY', BigInt('-200')),
      row('SALES_REVENUE', BigInt('-900')), // already includes posted returns/reversals
      row('SALES_DISCOUNT', BigInt('50')),
      row('COST_OF_GOODS_SOLD', BigInt('300')),
    ]);
    expect(sheet.currentResultMinor).toBe('550');
    expect(sheet.reconciliationGapMinor).toBe('0');
    expect(sheet.reconciled).toBe(true);
  });

  it.each([
    { name: 'redemption', refundedMinor: BigInt('0') },
    { name: 'partial refund', refundedMinor: BigInt('100') },
    { name: 'full refund', refundedMinor: BigInt('200') },
  ])('includes loyalty $name in the cumulative posted result', ({ refundedMinor }) => {
    // A 1000 sale is settled by 800 cash and 200 loyalty, then loyalty is refunded.
    const loyaltyMinor = BigInt('200') - refundedMinor;
    const [sheet] = classifyBalanceSheet([
      row('CASH', BigInt('800')),
      row('SALES_CLEARING', BigInt('0')),
      row('SALES_REVENUE', -BigInt('1000') + refundedMinor),
      row('LOYALTY_REDEMPTION', loyaltyMinor),
    ]);

    expect(
      sheet.accounts.find((account) => account.accountCode === 'LOYALTY_REDEMPTION')
    ).toMatchObject({
      section: 'currentResult',
      normalSide: 'DEBIT',
      normalBalanceMinor: loyaltyMinor.toString(),
    });
    expect(sheet.currentResultMinor).toBe('800');
    expect(sheet.unmappedAccountCodes).toEqual([]);
    expect(sheet.reconciliationGapMinor).toBe('0');
    expect(sheet.reconciled).toBe(true);
  });

  it('keeps currencies separate and safely handles integer values beyond Number precision', () => {
    const huge = BigInt('9007199254740993');
    const sheets = classifyBalanceSheet([
      row('CASH', huge, 'USD'),
      row('OPENING_BALANCE_EQUITY', -huge, 'USD'),
      row('CASH', BigInt('5'), 'PKR'),
      row('OPENING_BALANCE_EQUITY', BigInt('-5'), 'PKR'),
    ]);
    expect(sheets.map((sheet) => [sheet.currency, sheet.assetsMinor, sheet.reconciled])).toEqual([
      ['PKR', '5', true],
      ['USD', huge.toString(), true],
    ]);
  });

  it('shows nonzero unknown codes and blocks a reconciled claim without guessing policy', () => {
    const [sheet] = classifyBalanceSheet([
      row('CASH', BigInt('100')),
      row('FUTURE_WALLET', BigInt('-100')),
      row('ZERO_FUTURE_CODE', BigInt('0')),
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
