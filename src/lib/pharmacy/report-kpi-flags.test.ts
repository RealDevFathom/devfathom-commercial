import { describe, expect, it } from 'vitest';

import { pharmacyReportKpiFlags } from './report-kpi-flags';

describe('pharmacyReportKpiFlags (DEV-733)', () => {
  it('flags a refund ratio at or above the cash-close review threshold', () => {
    const flags = pharmacyReportKpiFlags({
      salesMinor: 212_197,
      refundsMinor: 82_797,
      cashVarianceMinor: null,
    });
    expect(flags.refundsMinor?.detail).toBe(
      'Refunds are 39.02% of sales, at or above the 10.00% review threshold.'
    );
  });

  it('does not flag a normal refund ratio or refunds below the minimum amount', () => {
    expect(
      pharmacyReportKpiFlags({ salesMinor: 1_000_000, refundsMinor: 60_000, cashVarianceMinor: 0 })
    ).toEqual({});
    expect(
      pharmacyReportKpiFlags({ salesMinor: 10_000, refundsMinor: 4_000, cashVarianceMinor: 0 })
    ).toEqual({});
  });

  it('flags refunds recorded with no sales', () => {
    expect(
      pharmacyReportKpiFlags({ salesMinor: 0, refundsMinor: 60_000, cashVarianceMinor: null })
        .refundsMinor?.detail
    ).toBe('Refunds recorded with no completed sales in this period.');
  });

  it('flags any non-zero cash variance with its direction', () => {
    expect(
      pharmacyReportKpiFlags({ salesMinor: 212_197, refundsMinor: 0, cashVarianceMinor: -400 })
        .cashVarianceMinor?.detail
    ).toBe('Counted cash is short of expected on final closes. Review the close notes.');
    expect(
      pharmacyReportKpiFlags({ salesMinor: 1, refundsMinor: 0, cashVarianceMinor: 250 })
        .cashVarianceMinor?.detail
    ).toContain('over');
  });

  it('never flags values that were not computed or are hidden', () => {
    expect(
      pharmacyReportKpiFlags({ salesMinor: null, refundsMinor: null, cashVarianceMinor: null })
    ).toEqual({});
    expect(
      pharmacyReportKpiFlags({ salesMinor: 10_000, refundsMinor: 90_000, cashVarianceMinor: null })
        .cashVarianceMinor
    ).toBeUndefined();
  });
});
