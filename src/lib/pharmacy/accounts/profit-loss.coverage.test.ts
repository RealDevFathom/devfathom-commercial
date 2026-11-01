import { describe, expect, it } from 'vitest';
import { projectProfitAndLoss } from './profit-loss';

describe('profit and loss classification coverage', () => {
  it('marks classified activity mapped', () => {
    expect(projectProfitAndLoss([
      { accountCode: 'SALES_REVENUE', currency: 'PKR', debit: 0n, credit: 100n },
    ])[0]?.classificationCoverage).toBe('mapped');
  });

  it('keeps unknown-only currencies visibly unmapped', () => {
    const result = projectProfitAndLoss([
      { accountCode: 'FUTURE_ACCOUNT', currency: 'USD', debit: 100n, credit: 0n },
    ]);
    expect(result[0]).toMatchObject({ currency: 'USD', classificationCoverage: 'unmapped' });
    expect(result[0]?.unmappedAccounts).toHaveLength(1);
  });

  it('does not hide offsetting unknown activity behind a zero net movement', () => {
    const result = projectProfitAndLoss([
      { accountCode: 'SALES_REVENUE', currency: 'PKR', debit: 0n, credit: 100n },
      { accountCode: 'FUTURE_ACCOUNT', currency: 'PKR', debit: 40n, credit: 0n },
      { accountCode: 'FUTURE_ACCOUNT', currency: 'PKR', debit: 0n, credit: 40n },
    ]);
    expect(result[0]?.classificationCoverage).toBe('unmapped');
    expect(result[0]?.unmappedAccounts[0]?.amountMinor).toBe('0');
  });
});
