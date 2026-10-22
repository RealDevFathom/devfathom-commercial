import { describe, expect, it } from 'vitest';
import { calculateFolioBalance, stayDates } from './folios';

describe('hotel folio ledger', () => {
  it('calculates charges, collections, and refunds in minor units', () => {
    expect(calculateFolioBalance('USD', [{ totalMinor: 12000, currency: 'USD' }], [
      { amountMinor: 12000, currency: 'USD', direction: 'COLLECTION' },
      { amountMinor: 2000, currency: 'USD', direction: 'REFUND' },
    ])).toBe(2000);
  });
  it('rejects mixed currencies', () => {
    expect(() => calculateFolioBalance('USD', [{ totalMinor: 1, currency: 'EUR' }], [])).toThrow('currency');
  });
  it('enumerates half-open room nights', () => {
    expect(stayDates(new Date('2026-10-22Z'), new Date('2026-10-24Z')).map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-10-22', '2026-10-23']);
  });
});
