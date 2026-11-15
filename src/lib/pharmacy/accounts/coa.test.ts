import { describe, expect, it } from 'vitest';
import { ACCOUNT_NORMAL_SIDE } from '@/lib/finance/journal';
import {
  isAllowedJournalVoucherLeg,
  isJournalVoucherPurpose,
  JOURNAL_VOUCHER_CATALOG,
  JOURNAL_VOUCHER_PURPOSES,
} from './coa';

const ALL_ACCOUNTS = Object.keys(ACCOUNT_NORMAL_SIDE);

describe('pharmacy journal voucher account catalog', () => {
  it('admits exactly one purpose: the non-trade operating accrual', () => {
    expect(JOURNAL_VOUCHER_PURPOSES).toEqual(['NONTRADE_OPERATING_ACCRUAL']);
    expect(isJournalVoucherPurpose('NONTRADE_OPERATING_ACCRUAL')).toBe(true);
    for (const other of [
      'TRADE_ACCRUAL',
      'SUPPLIER_PAYMENT',
      '',
      'nontrade_operating_accrual',
      7,
    ]) {
      expect(isJournalVoucherPurpose(other)).toBe(false);
    }
  });

  it('pins the accrual to debit operating expense and credit the non-trade accrual', () => {
    expect(
      JOURNAL_VOUCHER_CATALOG.NONTRADE_OPERATING_ACCRUAL.map(({ accountCode, side }) => [
        accountCode,
        side,
      ])
    ).toEqual([
      ['OPERATING_EXPENSE', 'DEBIT'],
      ['MANUAL_NONTRADE_ACCRUAL', 'CREDIT'],
    ]);
  });

  it('allows only the two catalogued legs and denies every other account/side pair', () => {
    const allowed: string[] = [];
    for (const account of ALL_ACCOUNTS) {
      for (const side of ['DEBIT', 'CREDIT']) {
        if (isAllowedJournalVoucherLeg('NONTRADE_OPERATING_ACCRUAL', account, side)) {
          allowed.push(`${account}:${side}`);
        }
      }
    }
    expect(allowed.sort()).toEqual(['MANUAL_NONTRADE_ACCRUAL:CREDIT', 'OPERATING_EXPENSE:DEBIT']);
  });

  it('denies every leg for an unknown purpose', () => {
    expect(isAllowedJournalVoucherLeg('OTHER', 'OPERATING_EXPENSE', 'DEBIT')).toBe(false);
    expect(isAllowedJournalVoucherLeg('OTHER', 'MANUAL_NONTRADE_ACCRUAL', 'CREDIT')).toBe(false);
  });

  it('records the new accrual as a credit-normal ledger account', () => {
    expect(ACCOUNT_NORMAL_SIDE.MANUAL_NONTRADE_ACCRUAL).toBe('CREDIT');
  });
});
