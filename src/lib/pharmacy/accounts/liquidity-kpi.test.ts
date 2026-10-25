import { describe, expect, it } from 'vitest';
import { liquidityKpiCsv, projectLiquidityKpi } from './liquidity-kpi';

const account = (accountCode: string, currency: string, closingMinor: string) => ({
  accountCode,
  currency,
  closingMinor,
});

describe('posted cash-coverage KPI', () => {
  it('keeps currencies independent and produces reduced exact rational strings', () => {
    const report = projectLiquidityKpi([
      account('CASH', 'PKR', '300'),
      account('BANK', 'PKR', '200'),
      account('ACCOUNTS_PAYABLE', 'PKR', '-300'),
      account('GOODS_RECEIVED_ACCRUAL', 'PKR', '-100'),
      account('CASH', 'USD', '9'),
      account('BANK', 'USD', '1'),
      account('ACCOUNTS_PAYABLE', 'USD', '-3'),
      account('GOODS_RECEIVED_ACCRUAL', 'USD', '-2'),
    ]);
    expect(report.rows.map((row) => [row.currency, row.ratio])).toEqual([
      ['PKR', { numerator: '5', denominator: '4' }],
      ['USD', { numerator: '2', denominator: '1' }],
    ]);
    expect(Object.isFrozen(report.rows[0])).toBe(true);
  });

  it('flags negative cash and unusual debit liability balances', () => {
    const [row] = projectLiquidityKpi([
      account('CASH', 'PKR', '-20'),
      account('BANK', 'PKR', '0'),
      account('ACCOUNTS_PAYABLE', 'PKR', '10'),
      account('GOODS_RECEIVED_ACCRUAL', 'PKR', '-40'),
    ]).rows;
    expect(row.availableFundsMinor).toBe('-20');
    expect(row.accountsPayableMinor).toBe('-10');
    expect(row.flags).toEqual([
      'Negative posted cash and bank balance',
      'Accounts payable has an unusual debit balance',
    ]);
  });

  it.each([
    ['zero', '0', '0'],
    ['negative', '20', '-10'],
  ])('makes a %s denominator unavailable', (_label, payable, accrual) => {
    const [row] = projectLiquidityKpi([
      account('CASH', 'PKR', '10'),
      account('BANK', 'PKR', '5'),
      account('ACCOUNTS_PAYABLE', 'PKR', payable),
      account('GOODS_RECEIVED_ACCRUAL', 'PKR', accrual),
    ]).rows;
    expect(row.ratio).toBeNull();
  });

  it('does not treat a missing component as zero and discloses unknown account coverage', () => {
    const report = projectLiquidityKpi([
      account('CASH', 'PKR', '10'),
      account('ACCOUNTS_PAYABLE', 'PKR', '-5'),
      account('UNCLASSIFIED', 'PKR', '99'),
    ]);
    expect(report.rows[0].ratio).toBeNull();
    expect(report.rows[0].missingComponents).toEqual(['BANK', 'GOODS_RECEIVED_ACCRUAL']);
    expect(report.unknownAccountCodes).toEqual(['UNCLASSIFIED']);
    expect(report.disclosures.join(' ')).toContain('completeness remain unknown');
  });

  it('exports exact evidence with CSV quoting and formula/control-character protection', () => {
    const report = projectLiquidityKpi([
      account('CASH', '=cmd\n', '10'),
      account('BANK', '=cmd\n', '5'),
      account('ACCOUNTS_PAYABLE', '=cmd\n', '-5'),
      account('GOODS_RECEIVED_ACCRUAL', '=cmd\n', '-5'),
      account('@unknown', '=cmd\n', '1'),
    ]);
    const csv = liquidityKpiCsv(report);
    expect(csv).toContain('"\'=cmd "');
    expect(csv).toContain('"3","2"');
    expect(csv).toContain('Other account codes excluded: @unknown');
    expect(csv).not.toContain('=cmd\n');
  });

  it('rejects non-integer money rather than converting it through Number', () => {
    expect(() => projectLiquidityKpi([account('CASH', 'PKR', '1.5')])).toThrow(TypeError);
  });
});

describe('current-head residual: unknown cash components and CSV', () => {
  const complete = () => [
    account('CASH', 'PKR', '0'),
    account('BANK', 'PKR', '9007199254740993'),
    account('ACCOUNTS_PAYABLE', 'PKR', '-3'),
    account('GOODS_RECEIVED_ACCRUAL', 'PKR', '0'),
  ];
  it.each([
    ['CASH', 'cashMinor', 'availableFundsMinor'],
    ['BANK', 'bankMinor', 'availableFundsMinor'],
    ['ACCOUNTS_PAYABLE', 'accountsPayableMinor', 'recordedLiabilitiesMinor'],
    ['GOODS_RECEIVED_ACCRUAL', 'goodsReceivedAccrualMinor', 'recordedLiabilitiesMinor'],
  ] as const)('keeps missing %s and its subtotal null, never zero', (code, field, total) => {
    const [row] = projectLiquidityKpi(complete().filter((item) => item.accountCode !== code)).rows;
    expect(row![field]).toBeNull();
    expect(row![total]).toBeNull();
    expect(row!.ratio).toBeNull();
  });
  it('preserves explicit zero, exact complete ratio, empty and unknown-only controls', () => {
    const report = projectLiquidityKpi(complete());
    expect(report.rows[0]).toMatchObject({
      cashMinor: '0',
      bankMinor: '9007199254740993',
      availableFundsMinor: '9007199254740993',
      goodsReceivedAccrualMinor: '0',
      ratio: { numerator: '3002399751580331', denominator: '1' },
    });
    expect(projectLiquidityKpi([]).rows).toEqual([]);
    expect(projectLiquidityKpi([account('UNCLASSIFIED', 'PKR', '9')]).rows).toEqual([]);
    const partial = liquidityKpiCsv(projectLiquidityKpi([account('BANK', 'PKR', '5')]));
    expect(partial.split('\r\n')[1]).toContain('"PKR","","5","","","","","",""');
    expect(partial).toContain('Missing: CASH|ACCOUNTS_PAYABLE|GOODS_RECEIVED_ACCRUAL');
  });
  it.each(['\u200b=cmd', '\u0600@cmd', '\u034f+cmd', '\u0085-cmd'])(
    'protects all control/format/mark-prefixed CSV formula %s',
    (currency) => {
      const csv = liquidityKpiCsv(projectLiquidityKpi([account('CASH', currency, '0')]));
      expect(csv.split('\r\n')[1]).toMatch(/"evidence","'[\s\p{M}]*[=+@-]cmd"/u);
      expect(projectLiquidityKpi([account('CASH', currency, '0')]).rows[0]!.currency).toBe(
        currency
      );
    }
  );
});
