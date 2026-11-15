/**
 * CEO-JVCORE-20261025: the narrow account catalog a pharmacy general-journal
 * voucher may use.
 *
 * This is deliberately NOT an editable chart of accounts. The canonical ledger
 * vocabulary is the `FinanceAccountCode` enum; this module only says which of
 * those accounts a manual voucher may touch, on which side, and for which
 * purpose. Exactly one purpose is admitted today:
 *
 *   NONTRADE_OPERATING_ACCRUAL — an operating expense incurred but not yet
 *   paid (rent, utilities, a service bill): debit OPERATING_EXPENSE, credit
 *   MANUAL_NONTRADE_ACCRUAL.
 *
 * Every other account/side/purpose combination is refused. Trade payables,
 * cash, bank, inventory and revenue keep their own operational adapters; a
 * manual voucher must never become a second way to write them.
 */
import type { FinanceAccountCode } from '@/generated/prisma/client';
import type { JournalSide } from '@/lib/finance/journal';

export const JOURNAL_VOUCHER_PURPOSES = ['NONTRADE_OPERATING_ACCRUAL'] as const;
export type JournalVoucherPurpose = (typeof JOURNAL_VOUCHER_PURPOSES)[number];

export type JournalVoucherAccountRule = {
  accountCode: FinanceAccountCode;
  side: JournalSide;
  label: string;
  description: string;
};

/**
 * The exact legs each purpose posts, in line order. A voucher's lines must
 * match this list one-for-one: same accounts, same sides, no extras.
 */
export const JOURNAL_VOUCHER_CATALOG: Readonly<
  Record<JournalVoucherPurpose, readonly JournalVoucherAccountRule[]>
> = {
  NONTRADE_OPERATING_ACCRUAL: [
    {
      accountCode: 'OPERATING_EXPENSE',
      side: 'DEBIT',
      label: 'Operating expenses',
      description: 'The non-trade operating cost incurred in the period.',
    },
    {
      accountCode: 'MANUAL_NONTRADE_ACCRUAL',
      side: 'CREDIT',
      label: 'Non-trade accruals',
      description: 'The amount owed for that cost until it is paid.',
    },
  ],
};

export const JOURNAL_VOUCHER_PURPOSE_LABELS: Readonly<Record<JournalVoucherPurpose, string>> = {
  NONTRADE_OPERATING_ACCRUAL: 'Non-trade operating accrual',
};

export function isJournalVoucherPurpose(value: unknown): value is JournalVoucherPurpose {
  return (
    typeof value === 'string' && (JOURNAL_VOUCHER_PURPOSES as readonly string[]).includes(value)
  );
}

/** True only for an account/side pair the purpose's catalog admits. */
export function isAllowedJournalVoucherLeg(
  purpose: string,
  accountCode: string,
  side: string
): boolean {
  if (!isJournalVoucherPurpose(purpose)) return false;
  return JOURNAL_VOUCHER_CATALOG[purpose].some(
    (rule) => rule.accountCode === accountCode && rule.side === side
  );
}
