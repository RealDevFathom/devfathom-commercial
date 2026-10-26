import { describe, expect, it } from 'vitest';
import { isPharmacyGeneralJournalAccount, PHARMACY_GENERAL_JOURNAL_ACCOUNTS } from './coa';

describe('narrow pharmacy journal account catalog', () => {
  it('exposes only the approved debit and credit accounts', () => {
    expect(PHARMACY_GENERAL_JOURNAL_ACCOUNTS).toEqual([
      { code: 'OPERATING_EXPENSE', name: 'Operating expense', normalSide: 'DEBIT' },
      { code: 'MANUAL_NONTRADE_ACCRUAL', name: 'Manual non-trade accrual', normalSide: 'CREDIT' },
    ]);
    expect(isPharmacyGeneralJournalAccount('BANK')).toBe(false);
  });
});
