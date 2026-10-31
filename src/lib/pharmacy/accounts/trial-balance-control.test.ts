import { describe, expect, it } from 'vitest';
import { InvalidTrialBalanceError, projectTrialBalanceControl } from './trial-balance-control';

const row = (overrides: Partial<Record<string, string>> = {}) => ({
  accountCode: 'CASH',
  currency: 'PKR',
  openingMinor: '0',
  debitMinor: '0',
  creditMinor: '0',
  closingMinor: '0',
  ...overrides,
});

describe('projectTrialBalanceControl', () => {
  it('controls balanced opening and debit-credit movement from supplied closings', () => {
    const report = projectTrialBalanceControl([
      row({ accountCode: 'CASH', openingMinor: '500', debitMinor: '200', closingMinor: '700' }),
      row({
        accountCode: 'CAPITAL',
        openingMinor: '-500',
        creditMinor: '200',
        closingMinor: '-700',
      }),
    ]);
    expect(report.currencies[0]).toMatchObject({
      openingDebit: BigInt(500),
      openingCredit: BigInt(500),
      openingDifference: BigInt(0),
      movementDebit: BigInt(200),
      movementCredit: BigInt(200),
      closingDebit: BigInt(700),
      closingCredit: BigInt(700),
      closingDifference: BigInt(0),
      bridgeDifference: BigInt(0),
    });
    expect(report.inconsistent).toBe(false);
  });

  it('retains a legitimate nonzero branch control with a valid bridge', () => {
    const report = projectTrialBalanceControl([row({ openingMinor: '10', closingMinor: '10' })]);
    expect(report.currencies[0]).toMatchObject({
      closingDifference: BigInt(10),
      bridgeDifference: BigInt(0),
    });
    expect(report.allZero).toBe(false);
  });

  it('exposes a wrong supplied closing in both row and bridge controls', () => {
    const report = projectTrialBalanceControl([row({ debitMinor: '10', closingMinor: '9' })]);
    expect(report.rows[0].rowDifference).toBe(-BigInt(1));
    expect(report.currencies[0].bridgeDifference).toBe(-BigInt(1));
    expect(report.inconsistent).toBe(true);
  });

  it('uses additive reversals and exact integers beyond Number precision', () => {
    const huge = '900719925474099300000';
    const report = projectTrialBalanceControl([
      row({ openingMinor: `-${huge}`, debitMinor: huge, closingMinor: '0' }),
    ]);
    expect(report.currencies[0].openingCredit).toBe(BigInt(huge));
    expect(report.currencies[0].movementDebit).toBe(BigInt(huge));
    expect(report.currencies[0].bridgeDifference).toBe(BigInt(0));
  });

  it('isolates currencies and retains unknown account codes', () => {
    const report = projectTrialBalanceControl([
      row({ accountCode: 'UNRECOGNIZED_LEDGER_CODE', currency: 'USD', closingMinor: '3' }),
      row({ accountCode: 'CASH', currency: 'PKR', closingMinor: '-4' }),
    ]);
    expect(report.currencies.map((control) => control.currency)).toEqual(['PKR', 'USD']);
    expect(report.rows[0].accountCode).toBe('UNRECOGNIZED_LEDGER_CODE');
  });

  it.each([
    [row({ debitMinor: '-1' })],
    [row({ creditMinor: '1.2' })],
    [row({ openingMinor: '+1' })],
    [row({ openingMinor: '-0' })],
    [row({ closingMinor: '-0' })],
    [row({ closingMinor: '1'.repeat(129) })],
    [row({ accountCode: '' })],
    [row({ accountCode: '¢'.repeat(65) })],
    [row({ currency: 'x'.repeat(33) })],
  ])('rejects negative movements and malformed or over-bound fields', (account) => {
    expect(() => projectTrialBalanceControl([account])).toThrow(InvalidTrialBalanceError);
  });

  it('rejects duplicate account/currency pairs', () => {
    expect(() => projectTrialBalanceControl([row(), row()])).toThrow(InvalidTrialBalanceError);
  });

  it('distinguishes empty from nonempty all-zero data', () => {
    expect(projectTrialBalanceControl([])).toMatchObject({ empty: true, allZero: false });
    expect(projectTrialBalanceControl([row()])).toMatchObject({ empty: false, allZero: true });
  });

  it('accepts 256, rejects 257 without mutating frozen input or returning partial totals', () => {
    const accepted = Object.freeze(
      Array.from({ length: 256 }, (_, index) => Object.freeze(row({ accountCode: `A${index}` })))
    );
    expect(projectTrialBalanceControl(accepted).rows).toHaveLength(256);
    const refused = Object.freeze([...accepted, Object.freeze(row({ accountCode: 'TOO_MANY' }))]);
    expect(() => projectTrialBalanceControl(refused)).toThrow(InvalidTrialBalanceError);
    expect(refused[0]).toEqual(row({ accountCode: 'A0' }));
  });
});
