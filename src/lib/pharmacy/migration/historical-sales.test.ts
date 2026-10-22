import { describe, expect, it } from 'vitest';
import { CUSTOMER_ACTIVITY_SOURCES, importedLoyaltyPoints, importedSalesAnalyticsSql } from './historical-sales';

describe('historical import isolation', () => {
  it('cannot enter day-close, cash, finance or tax because the analytics query reads only the isolated table', () => {
    expect(importedSalesAnalyticsSql).toContain('pharmacy_imported_sales');
    for (const forbidden of ['pharmacy_tenders', 'pharmacy_daily_closes', 'finance_journal', 'tax'])
      expect(importedSalesAnalyticsSql).not.toContain(forbidden);
  });

  it('defaults loyalty off and awards only after owner opt-in', () => {
    expect(importedLoyaltyPoints({ ownerOptIn: false, netPaidMinor: 25_000n, minorPerPoint: 10_000n })).toBe(0n);
    expect(importedLoyaltyPoints({ ownerOptIn: true, netPaidMinor: 25_000n, minorPerPoint: 10_000n })).toBe(2n);
  });

  it('includes imported history in churn and win-back activity baselines', () => {
    expect(CUSTOMER_ACTIVITY_SOURCES).toContain('pharmacy_imported_sales');
  });
});
