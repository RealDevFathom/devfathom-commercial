import type { FinanceAccountCode } from '@/generated/prisma/client';

export type PharmacyJournalAccount = Readonly<{
  code: FinanceAccountCode;
  name: string;
  normalSide: 'DEBIT' | 'CREDIT';
}>;

/** The complete account surface exposed by the narrow voucher workflow. */
export const PHARMACY_GENERAL_JOURNAL_ACCOUNTS = [
  { code: 'OPERATING_EXPENSE', name: 'Operating expense', normalSide: 'DEBIT' },
  { code: 'MANUAL_NONTRADE_ACCRUAL', name: 'Manual non-trade accrual', normalSide: 'CREDIT' },
] as const satisfies readonly PharmacyJournalAccount[];

export function isPharmacyGeneralJournalAccount(value: string): value is FinanceAccountCode {
  return PHARMACY_GENERAL_JOURNAL_ACCOUNTS.some(({ code }) => code === value);
}
