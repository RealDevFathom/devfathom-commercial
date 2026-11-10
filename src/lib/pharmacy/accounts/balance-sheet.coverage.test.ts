import { describe, expect, it } from 'vitest';
import { classifyBalanceSheet } from './balance-sheet';

describe('balance sheet coverage is independent of its posted equation', () => {
  it.each(['constructor', 'toString', '__proto__'])(
    'keeps the unknown code %s unmapped even when it names an object property',
    (accountCode) => {
      const [sheet] = classifyBalanceSheet([
        {
          accountCode,
          currency: 'PKR',
          openingMinor: '0',
          debitMinor: '100',
          creditMinor: '0',
          closingMinor: '100',
        },
      ]);
      expect(sheet?.accounts[0]).toMatchObject({
        section: 'unmapped',
        normalSide: null,
        closingMinor: '100',
        normalBalanceMinor: '100',
      });
      expect(sheet?.unmappedAccountCodes).toEqual([accountCode]);
      expect(sheet?.reconciled).toBe(false);
    }
  );

  it('does not claim reconciliation for offsetting nonzero unmapped wallets', () => {
    const [sheet] = classifyBalanceSheet([
      {
        accountCode: 'CUSTOMER_WALLET',
        currency: 'PKR',
        openingMinor: '0',
        debitMinor: '100',
        creditMinor: '0',
        closingMinor: '100',
      },
      {
        accountCode: 'SUPPLIER_WALLET',
        currency: 'PKR',
        openingMinor: '0',
        debitMinor: '0',
        creditMinor: '100',
        closingMinor: '-100',
      },
    ]);
    expect(sheet?.reconciliationGapMinor).toBe('0');
    expect(sheet?.reconciled).toBe(false);
    expect(sheet?.unmappedAccountCodes).toEqual(['CUSTOMER_WALLET', 'SUPPLIER_WALLET']);
  });
});
