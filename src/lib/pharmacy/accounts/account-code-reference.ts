import type { FinanceAccountCode } from '@/generated/prisma/client';
import { ACCOUNT_NORMAL_SIDE, type JournalSide } from '@/lib/finance/journal';

export type AccountCodeReferenceRow = Readonly<{
  code: FinanceAccountCode;
  normalSide: JournalSide;
}>;

/**
 * Returns a read-only, deterministic view of the canonical journal account metadata.
 * The journal mapping remains the single source of truth; callers receive neither it nor
 * mutable row objects.
 */
export function accountCodeReference(): readonly AccountCodeReferenceRow[] {
  return Object.freeze(
    (Object.entries(ACCOUNT_NORMAL_SIDE) as [FinanceAccountCode, JournalSide][])
      .map(([code, normalSide]) => Object.freeze({ code, normalSide }))
      .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0))
  );
}
