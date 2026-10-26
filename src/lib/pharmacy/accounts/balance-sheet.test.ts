import { describe, expect, it } from 'vitest';
import { classifyBalanceSheet } from './balance-sheet';

const account = (accountCode: string, closingMinor: bigint, currency = 'PKR') => ({
  accountCode,
  currency,
  closingMinor: closingMinor.toString(),
});

describe('classifyBalanceSheet', () => {
  it('classifies opening cash, inventory/AP, sale/COGS, expense, discounts and returns once', () => {
    const [sheet] = classifyBalanceSheet([
      account('CASH', 80_000n),
      account('INVENTORY', 35_000n),
      account('INVENTORY_IN_TRANSIT', 5_000n),
      account('ACCOUNTS_RECEIVABLE', 4_000n),
      account('SUPPLIER_CLAIM_RECEIVABLE', 1_000n),
      account('SALES_CLEARING', 0n),
      account('ACCOUNTS_PAYABLE', -20_000n),
      account('GOODS_RECEIVED_ACCRUAL', -5_000n),
      account('OPENING_BALANCE_EQUITY', -75_000n),
      account('SALES_REVENUE', -30_000n),
      account('COST_OF_GOODS_SOLD', 10_000n),
      account('OPERATING_EXPENSE', 4_000n),
      account('SALES_DISCOUNT', 1_000n),
      account('INVENTORY_SHRINKAGE', 0n),
      account('LOYALTY_REDEMPTION', 0n),
      account('CASH_OVER_SHORT', 0n),
    ]);

    expect(sheet.currentResultMinor).toBe('15000');
    expect(sheet.totals).toEqual({
      assetsMinor: '125000',
      liabilitiesMinor: '25000',
      openingEquityMinor: '75000',
      equityAndLiabilitiesMinor: '115000',
      reconciliationGapMinor: '10000',
    });
    expect(sheet.status).toBe('gap');
    expect(sheet.assets.map((line) => line.label)).toEqual(
      expect.arrayContaining([
        'Inventory in transit',
        'Customer receivables',
        'Supplier claims receivable',
      ])
    );
  });

  it('preserves large integers and additive reversal balances without Number rounding', () => {
    const large = 9_007_199_254_740_993n;
    const [sheet] = classifyBalanceSheet([
      account('BANK', large - 2n),
      account('ACCOUNTS_RECEIVABLE', 2n),
      account('OPENING_BALANCE_EQUITY', -large),
    ]);
    expect(sheet.totals.assetsMinor).toBe(large.toString());
    expect(sheet.status).toBe('reconciled');
  });

  it('separates currencies and makes nonzero unknown codes block a complete claim', () => {
    const sheets = classifyBalanceSheet([
      account('CASH', 100n, 'PKR'),
      account('OPENING_BALANCE_EQUITY', -100n, 'PKR'),
      account('FUTURE_WALLET', 25n, 'USD'),
      account('UNKNOWN_ZERO', 0n, 'USD'),
    ]);
    expect(sheets.map((sheet) => sheet.currency)).toEqual(['PKR', 'USD']);
    expect(sheets[0].status).toBe('reconciled');
    expect(sheets[1].status).toBe('incomplete');
    expect(sheets[1].unmapped).toEqual([account('FUTURE_WALLET', 25n, 'USD')]);
  });

  it('returns no currencies for an empty canonical source', () => {
    expect(classifyBalanceSheet([])).toEqual([]);
  });
});
