import { describe, expect, it } from 'vitest';
import { projectProfitAndLoss } from './profit-loss';

const movement = (accountCode: string, debit: number, credit: number, currency = 'PKR') => ({
  accountCode,
  currency,
  debit: BigInt(debit),
  credit: BigInt(credit),
});

describe('profit and loss classification coverage', () => {
  it('marks classified activity mapped', () => {
    expect(
      projectProfitAndLoss([movement('SALES_REVENUE', 0, 100)])[0]?.classificationCoverage
    ).toBe('mapped');
  });

  it('keeps unknown-only currencies visibly unmapped', () => {
    const result = projectProfitAndLoss([movement('FUTURE_ACCOUNT', 100, 0, 'USD')]);
    expect(result[0]).toMatchObject({ currency: 'USD', classificationCoverage: 'unmapped' });
    expect(result[0]?.unmappedAccounts).toHaveLength(1);
  });

  it('does not hide offsetting unknown activity behind a zero net movement', () => {
    const result = projectProfitAndLoss([
      movement('SALES_REVENUE', 0, 100),
      movement('FUTURE_ACCOUNT', 40, 0),
      movement('FUTURE_ACCOUNT', 0, 40),
    ]);
    expect(result[0]?.classificationCoverage).toBe('unmapped');
    expect(result[0]?.unmappedAccounts[0]?.amountMinor).toBe('0');
  });
});
