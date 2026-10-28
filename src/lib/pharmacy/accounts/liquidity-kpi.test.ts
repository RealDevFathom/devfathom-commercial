import { describe, expect, it } from 'vitest';
import { formatCoverageRatio, postedCashCoverage, postedCashCoverageCsv } from './liquidity-kpi';

describe('posted cash coverage', () => {
  it('keeps components and currencies separate with credit-positive liabilities', () => {
    const rows = postedCashCoverage([
      { accountCode: 'CASH', currency: 'PKR', closingMinor: '500' },
      { accountCode: 'BANK', currency: 'PKR', closingMinor: '250' },
      { accountCode: 'ACCOUNTS_PAYABLE', currency: 'PKR', closingMinor: '-200' },
      { accountCode: 'GOODS_RECEIVED_ACCRUAL', currency: 'PKR', closingMinor: '-100' },
      { accountCode: 'CASH', currency: 'USD', closingMinor: '90' },
      { accountCode: 'ACCOUNTS_PAYABLE', currency: 'USD', closingMinor: '-30' },
      { accountCode: 'SALES', currency: 'PKR', closingMinor: '-999999' },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({
        currency: 'PKR',
        cashMinor: '500',
        bankMinor: '250',
        accountsPayableMinor: '200',
        goodsReceivedAccrualMinor: '100',
        numeratorMinor: '750',
        denominatorMinor: '300',
        ratio: { numerator: '750', denominator: '300' },
        status: 'available',
        flags: [],
      }),
      expect.objectContaining({
        currency: 'USD',
        numeratorMinor: '90',
        denominatorMinor: '30',
        ratio: { numerator: '90', denominator: '30' },
      }),
    ]);
    expect(formatCoverageRatio(rows[0]!)).toBe('2.50×');
  });

  it('uses bigint arithmetic and retains exact ratio strings', () => {
    const [row] = postedCashCoverage([
      { accountCode: 'CASH', currency: 'PKR', closingMinor: '900719925474099312345' },
      { accountCode: 'ACCOUNTS_PAYABLE', currency: 'PKR', closingMinor: '-3' },
    ]);
    expect(row?.ratio).toEqual({ numerator: '900719925474099312345', denominator: '3' });
  });

  it.each([
    { name: 'missing', balances: [{ accountCode: 'CASH', currency: 'PKR', closingMinor: '1' }] },
    {
      name: 'zero',
      balances: [
        { accountCode: 'CASH', currency: 'PKR', closingMinor: '1' },
        { accountCode: 'ACCOUNTS_PAYABLE', currency: 'PKR', closingMinor: '0' },
      ],
    },
    {
      name: 'negative',
      balances: [
        { accountCode: 'CASH', currency: 'PKR', closingMinor: '1' },
        { accountCode: 'ACCOUNTS_PAYABLE', currency: 'PKR', closingMinor: '2' },
      ],
    },
  ])('never emits infinity for a $name/nonpositive denominator', ({ balances }) => {
    const [row] = postedCashCoverage(balances);
    expect(row).toMatchObject({ status: 'unavailable', ratio: null });
    expect(formatCoverageRatio(row!)).toBe('Unavailable');
  });

  it('flags negative cash and unusual debit liability balances', () => {
    const [row] = postedCashCoverage([
      { accountCode: 'BANK', currency: 'PKR', closingMinor: '-5' },
      { accountCode: 'ACCOUNTS_PAYABLE', currency: 'PKR', closingMinor: '2' },
      { accountCode: 'GOODS_RECEIVED_ACCRUAL', currency: 'PKR', closingMinor: '-10' },
    ]);
    expect(row?.flags).toEqual(['NEGATIVE_CASH', 'DEBIT_LIABILITY']);
  });

  it('makes a formula-safe CSV without mutating rows', () => {
    const rows = postedCashCoverage([
      { accountCode: 'CASH', currency: '=cmd', closingMinor: '10' },
      { accountCode: 'ACCOUNTS_PAYABLE', currency: '=cmd', closingMinor: '-2' },
    ]);
    const before = structuredClone(rows);
    const csv = postedCashCoverageCsv(rows);
    expect(csv).toContain('"\'=cmd"');
    expect(csv).toContain('"10/2"');
    expect(csv).not.toContain('Infinity');
    expect(rows).toEqual(before);
  });
});
