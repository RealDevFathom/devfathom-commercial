/**
 * PHARM-ACCOUNTS-CODE-REFERENCE — a read-only, browseable view of the canonical
 * finance account codes and the side that increases each one.
 *
 * THE SOURCE OF TRUTH IS `ACCOUNT_NORMAL_SIDE` in `src/lib/finance/journal.ts`.
 * This module derives every row from that mapping on each call: it does not
 * copy, reorder by meaning, reclassify (asset/liability/…), or extend it, and
 * it exports no mutable mapping of its own. Nothing here reads the database,
 * balances, hierarchy, or journal entries, and nothing here writes.
 */
import type { FinanceAccountCode } from '@/generated/prisma/client';
import { ACCOUNT_NORMAL_SIDE, type JournalSide } from '@/lib/finance/journal';

export type AccountCodeReferenceRow = Readonly<{
  /** The canonical account code, exactly as the journal stores it. */
  code: FinanceAccountCode;
  /** The canonical normal side, exactly as `ACCOUNT_NORMAL_SIDE` declares it. */
  normalSide: JournalSide;
  /** Presentation-only label derived from the code; it carries no classification. */
  label: string;
}>;

export type AccountCodeReference = Readonly<{
  rows: readonly AccountCodeReferenceRow[];
  debitCount: number;
  creditCount: number;
}>;

/** `COST_OF_GOODS_SOLD` → `Cost of goods sold`. Presentation only. */
export function accountCodeLabel(code: string): string {
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Every canonical code exactly once, in the canonical mapping's declaration
 * order (string-keyed object order is deterministic), each row and the list
 * frozen so a caller cannot mutate the reference it was handed.
 *
 * Fails closed: an entry whose side is not DEBIT or CREDIT throws rather than
 * being shown with a guessed side.
 */
export function accountCodeReference(): AccountCodeReference {
  const rows: AccountCodeReferenceRow[] = [];
  const seen = new Set<string>();
  for (const [code, normalSide] of Object.entries(ACCOUNT_NORMAL_SIDE)) {
    if (normalSide !== 'DEBIT' && normalSide !== 'CREDIT')
      throw new Error(`Account code ${code} has no canonical normal side.`);
    if (seen.has(code)) throw new Error(`Account code ${code} is duplicated.`);
    seen.add(code);
    rows.push(
      Object.freeze({
        code: code as FinanceAccountCode,
        normalSide,
        label: accountCodeLabel(code),
      })
    );
  }
  const frozen = Object.freeze(rows);
  return Object.freeze({
    rows: frozen,
    debitCount: frozen.filter((row) => row.normalSide === 'DEBIT').length,
    creditCount: frozen.filter((row) => row.normalSide === 'CREDIT').length,
  });
}
