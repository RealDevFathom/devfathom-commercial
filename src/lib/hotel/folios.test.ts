import { describe, expect, it } from 'vitest';
import { calculateFolioBalance } from './folios';

describe('hotel folio ledger', () => {
  it('nets charges, reversals, collections and refunds in minor units', () => {
    expect(
      calculateFolioBalance(
        'USD',
        [
          { grossMinor: BigInt(12_000), currency: 'USD', reversesEntryId: null },
          { grossMinor: BigInt(3_000), currency: 'USD', reversesEntryId: null },
          { grossMinor: BigInt(3_000), currency: 'USD', reversesEntryId: 'entry-2' },
        ],
        [
          { amountMinor: BigInt(12_000), currency: 'USD', direction: 'COLLECTION' },
          { amountMinor: BigInt(2_000), currency: 'USD', direction: 'REFUND' },
        ]
      )
    ).toBe(BigInt(2_000));
  });

  it('shows a fully paid folio as zero, not the charged amount', () => {
    expect(
      calculateFolioBalance(
        'PKR',
        [{ grossMinor: BigInt(5_000), currency: 'PKR', reversesEntryId: null }],
        [{ amountMinor: BigInt(5_000), currency: 'PKR', direction: 'COLLECTION' }]
      )
    ).toBe(BigInt(0));
  });

  it('rejects mixed currencies', () => {
    expect(() =>
      calculateFolioBalance('USD', [{ grossMinor: BigInt(1), currency: 'EUR', reversesEntryId: null }], [])
    ).toThrow('currency');
  });
});
