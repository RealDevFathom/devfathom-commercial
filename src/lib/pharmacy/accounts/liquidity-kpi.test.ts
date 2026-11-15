import { describe, expect, it } from 'vitest';

import {
  InvalidLiquidityKpiSourceError,
  LIQUIDITY_KPI_MAX_ROWS,
  liquidityKpiCsv,
  projectLiquidityKpi,
  ratioDecimal,
} from './liquidity-kpi';

function row(accountCode: string, currency: string, closingMinor: string) {
  return {
    accountCode,
    currency,
    openingMinor: '0',
    debitMinor: '0',
    creditMinor: '0',
    closingMinor,
  };
}

describe('projectLiquidityKpi', () => {
  it('divides CASH + BANK by credit-positive AP + goods-received accrual with exact strings', () => {
    const kpi = projectLiquidityKpi([
      row('CASH', 'PKR', '15000'),
      row('BANK', 'PKR', '5000'),
      row('ACCOUNTS_PAYABLE', 'PKR', '-6000'),
      row('GOODS_RECEIVED_ACCRUAL', 'PKR', '-2000'),
      row('INVENTORY', 'PKR', '999999'),
      row('SALES_REVENUE', 'PKR', '-999999'),
    ]);
    expect(kpi.empty).toBe(false);
    expect(kpi.currencies).toEqual([
      {
        currency: 'PKR',
        cashMinor: '15000',
        bankMinor: '5000',
        accountsPayableMinor: '6000',
        goodsReceivedAccrualMinor: '2000',
        numeratorMinor: '20000',
        denominatorMinor: '8000',
        ratio: '20000/8000',
        ratioDecimal: '2.5000',
        unavailableReason: null,
        flags: [],
      },
    ]);
  });

  it('keeps recorded currencies isolated and sorted', () => {
    const kpi = projectLiquidityKpi([
      row('CASH', 'USD', '100'),
      row('ACCOUNTS_PAYABLE', 'USD', '-300'),
      row('CASH', 'PKR', '900'),
      row('ACCOUNTS_PAYABLE', 'PKR', '-100'),
    ]);
    expect(kpi.currencies.map((c) => [c.currency, c.ratio, c.ratioDecimal])).toEqual([
      ['PKR', '900/100', '9.0000'],
      ['USD', '100/300', '0.3333'],
    ]);
  });

  it('keeps exact precision above Number.MAX_SAFE_INTEGER', () => {
    const kpi = projectLiquidityKpi([
      row('CASH', 'PKR', '900719925474099301'),
      row('BANK', 'PKR', '9'),
      row('ACCOUNTS_PAYABLE', 'PKR', '-900719925474099310'),
    ]);
    expect(kpi.currencies[0]).toMatchObject({
      numeratorMinor: '900719925474099310',
      denominatorMinor: '900719925474099310',
      ratio: '900719925474099310/900719925474099310',
      ratioDecimal: '1.0000',
    });
  });

  it('reports missing, zero and negative denominators as unavailable, never infinity', () => {
    const missing = projectLiquidityKpi([row('CASH', 'PKR', '500')]).currencies[0];
    expect(missing).toMatchObject({
      denominatorMinor: '0',
      ratio: null,
      ratioDecimal: null,
      unavailableReason: 'NO_RECORDED_LIABILITIES',
    });
    const zero = projectLiquidityKpi([
      row('CASH', 'PKR', '500'),
      row('ACCOUNTS_PAYABLE', 'PKR', '0'),
    ]).currencies[0];
    expect(zero).toMatchObject({ ratio: null, unavailableReason: 'NONPOSITIVE_LIABILITIES' });
    const negative = projectLiquidityKpi([
      row('CASH', 'PKR', '500'),
      row('ACCOUNTS_PAYABLE', 'PKR', '40'),
    ]).currencies[0];
    expect(negative).toMatchObject({
      accountsPayableMinor: '-40',
      denominatorMinor: '-40',
      ratio: null,
      ratioDecimal: null,
      unavailableReason: 'NONPOSITIVE_LIABILITIES',
      flags: ['DEBIT_ACCOUNTS_PAYABLE'],
    });
    for (const result of [missing, zero, negative]) {
      expect(JSON.stringify(result)).not.toMatch(/Infinity|NaN/);
    }
  });

  it('flags negative cash or bank and unusual debit liabilities without repairing them', () => {
    const kpi = projectLiquidityKpi([
      row('CASH', 'PKR', '-100'),
      row('BANK', 'PKR', '-1'),
      row('ACCOUNTS_PAYABLE', 'PKR', '-1000'),
      row('GOODS_RECEIVED_ACCRUAL', 'PKR', '10'),
    ]).currencies[0];
    expect(kpi).toMatchObject({
      numeratorMinor: '-101',
      denominatorMinor: '990',
      ratio: '-101/990',
      ratioDecimal: '-0.1020',
      flags: ['NEGATIVE_CASH', 'NEGATIVE_BANK', 'DEBIT_GOODS_RECEIVED_ACCRUAL'],
    });
  });

  it('returns an empty projection when no KPI accounts are posted', () => {
    expect(projectLiquidityKpi([])).toEqual({ currencies: [], empty: true });
    expect(projectLiquidityKpi([row('INVENTORY', 'PKR', '10')])).toEqual({
      currencies: [],
      empty: true,
    });
  });

  it.each([
    null,
    {},
    [null],
    [row('CASH', 'PKR', '1.5')],
    [row('CASH', 'PKR', '01')],
    [row('CASH', 'PKR', '')],
    [{ ...row('CASH', 'PKR', '1'), closingMinor: 1 }],
    [row('', 'PKR', '1')],
    [row('CASH', '', '1')],
    [row('CASH', 'PKR', '1'), row('CASH', 'PKR', '2')],
    [row('INVENTORY', 'PKR', 'not-a-number')],
    Array.from({ length: LIQUIDITY_KPI_MAX_ROWS + 1 }, (_, i) => row(`A${i}`, 'PKR', '0')),
  ])('rejects an invalid account source before producing any KPI', (accounts) => {
    expect(() => projectLiquidityKpi(accounts)).toThrow(InvalidLiquidityKpiSourceError);
  });

  it('does not mutate the supplied accounts', () => {
    const accounts = Object.freeze([
      Object.freeze(row('CASH', 'PKR', '10')),
      Object.freeze(row('ACCOUNTS_PAYABLE', 'PKR', '-5')),
    ]);
    const before = JSON.stringify(accounts);
    projectLiquidityKpi(accounts);
    expect(JSON.stringify(accounts)).toBe(before);
  });
});

describe('ratioDecimal', () => {
  it('truncates toward zero and refuses a nonpositive denominator', () => {
    expect(ratioDecimal(BigInt(2), BigInt(3))).toBe('0.6666');
    expect(ratioDecimal(BigInt(-2), BigInt(3))).toBe('-0.6666');
    expect(ratioDecimal(BigInt(-1), BigInt(100000))).toBe('0.0000');
    expect(() => ratioDecimal(BigInt(1), BigInt(0))).toThrow(RangeError);
    expect(() => ratioDecimal(BigInt(1), BigInt(-1))).toThrow(RangeError);
  });
});

describe('liquidityKpiCsv', () => {
  it('serializes quoted, formula-safe rows per currency', () => {
    const kpi = projectLiquidityKpi([
      row('CASH', 'PKR', '-100'),
      row('ACCOUNTS_PAYABLE', 'PKR', '-50'),
      row('CASH', 'USD', '7'),
    ]);
    const csv = liquidityKpiCsv(kpi, {
      branchId: '=HYPERLINK("x")\r\nbranch',
      cutoff: '2026-02-01T00:00:00.000Z',
      retrievedAt: '2026-02-02T03:04:05.000Z',
    });
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      '"evidence_scope","branch_id","cutoff_exclusive_utc","retrieved_at_utc","recorded_currency","cash_minor","bank_minor","accounts_payable_minor","goods_received_accrual_minor","numerator_minor","denominator_minor","ratio_exact","ratio_truncated_4dp","status","flags"'
    );
    expect(lines[1]).toContain(`"'=HYPERLINK(""x"")  branch"`);
    expect(lines[1]).toContain('"PKR"');
    expect(lines[1]).toContain(`"'-100/50"`);
    expect(lines[1]).toContain(`"'-2.0000","AVAILABLE","NEGATIVE_CASH"`);
    expect(lines[2]).toContain('"USD","7","0","0","0","7","0","","","NO_RECORDED_LIABILITIES",""');
  });

  it('emits only the header for an empty projection', () => {
    expect(
      liquidityKpiCsv(projectLiquidityKpi([]), {
        branchId: 'b',
        cutoff: 'c',
        retrievedAt: 'r',
      }).split('\r\n')
    ).toHaveLength(1);
  });
});
