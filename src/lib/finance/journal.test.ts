/**
 * FIN-01 — the pure half of the shared journal: the balance kernel and the sign
 * convention every FIN-03 read folds with.
 *
 * The database-backed guarantees (the deferred balance trigger, append-only,
 * at-most-one reversal, tenant isolation) are in `journal.db.test.ts`; those
 * are claims about PostgreSQL and cannot be shown here.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_NORMAL_SIDE,
  assertBalanced,
  FinancePostingError,
  signedMinor,
  type JournalLineInput,
} from './journal';

function leg(
  accountCode: JournalLineInput['accountCode'],
  side: JournalLineInput['side'],
  amountMinor: number
): JournalLineInput {
  return { accountCode, side, amountMinor };
}

describe('assertBalanced — FIN-01 balanced postings', () => {
  it('accepts an entry whose debits equal its credits', () => {
    expect(() =>
      assertBalanced([leg('COST_OF_GOODS_SOLD', 'DEBIT', 1200), leg('INVENTORY', 'CREDIT', 1200)])
    ).not.toThrow();
  });

  it('accepts many legs on each side as long as the totals agree', () => {
    expect(() =>
      assertBalanced([
        leg('SALES_CLEARING', 'DEBIT', 900),
        leg('SALES_DISCOUNT', 'DEBIT', 100),
        leg('SALES_REVENUE', 'CREDIT', 1000),
      ])
    ).not.toThrow();
  });

  it('refuses an entry that does not balance, by one minor unit', () => {
    expect(() =>
      assertBalanced([
        leg('INVENTORY', 'DEBIT', 1000),
        leg('GOODS_RECEIVED_ACCRUAL', 'CREDIT', 999),
      ])
    ).toThrow(new FinancePostingError('UNBALANCED'));
  });

  it('detects a one-unit imbalance even when accumulated totals exceed number precision', () => {
    const max = Number.MAX_SAFE_INTEGER;
    expect(() =>
      assertBalanced([
        leg('INVENTORY', 'DEBIT', max),
        leg('INVENTORY', 'DEBIT', 2),
        leg('OPENING_BALANCE_EQUITY', 'CREDIT', max),
        leg('OPENING_BALANCE_EQUITY', 'CREDIT', 1),
      ])
    ).toThrow(new FinancePostingError('UNBALANCED'));
    expect(() =>
      assertBalanced([
        leg('INVENTORY', 'DEBIT', max),
        leg('INVENTORY', 'DEBIT', 2),
        leg('OPENING_BALANCE_EQUITY', 'CREDIT', max - 1),
        leg('OPENING_BALANCE_EQUITY', 'CREDIT', 3),
      ])
    ).not.toThrow();
  });

  it('refuses an entry with no legs', () => {
    expect(() => assertBalanced([])).toThrow(new FinancePostingError('EMPTY_ENTRY'));
  });

  it('refuses a one-sided entry even though its own total is consistent', () => {
    expect(() =>
      assertBalanced([leg('INVENTORY', 'DEBIT', 500), leg('INVENTORY', 'DEBIT', 500)])
    ).toThrow(new FinancePostingError('EMPTY_ENTRY'));
  });

  it.each([0, -100, 12.5, Number.NaN])('refuses %p as a leg amount', (amountMinor) => {
    expect(() =>
      assertBalanced([
        leg('INVENTORY', 'DEBIT', amountMinor),
        leg('GOODS_RECEIVED_ACCRUAL', 'CREDIT', 100),
      ])
    ).toThrow(new FinancePostingError('INVALID_AMOUNT'));
  });
});

describe('signedMinor — the FIN-03 sign convention', () => {
  it('reads an increase in a debit account as positive', () => {
    expect(signedMinor(leg('INVENTORY', 'DEBIT', 1200))).toBe(1200);
    expect(signedMinor(leg('INVENTORY', 'CREDIT', 1200))).toBe(-1200);
  });

  it('reads earned revenue as positive even though it is posted as a credit', () => {
    expect(signedMinor(leg('SALES_REVENUE', 'CREDIT', 5000))).toBe(5000);
    expect(signedMinor(leg('SALES_REVENUE', 'DEBIT', 5000))).toBe(-5000);
  });

  it('nets a posting against its reversal to zero', () => {
    const posted = leg('COST_OF_GOODS_SOLD', 'DEBIT', 3400);
    const reversed = leg('COST_OF_GOODS_SOLD', 'CREDIT', 3400);
    expect(signedMinor(posted) + signedMinor(reversed)).toBe(0);
  });

  it('gives every account a normal side', () => {
    for (const side of Object.values(ACCOUNT_NORMAL_SIDE)) {
      expect(['DEBIT', 'CREDIT']).toContain(side);
    }
  });
});
