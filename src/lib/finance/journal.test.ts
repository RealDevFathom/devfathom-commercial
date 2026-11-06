/**
 * FIN-01 — the pure half of the shared journal: the balance kernel and the sign
 * convention every FIN-03 read folds with.
 *
 * The database-backed guarantees (the deferred balance trigger, append-only,
 * at-most-one reversal, tenant isolation) are in `journal.db.test.ts`; those
 * are claims about PostgreSQL and cannot be shown here.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_NORMAL_SIDE,
  assertBalanced,
  FinancePostingError,
  postJournalEntry,
  signedMinor,
  type JournalLineInput,
  type PostJournalEntryInput,
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

describe('E1 compatibility — voucher replay identity and sum bounds', () => {
  const scope = { organizationId: 'org_e1', actorId: 'actor_e1' };
  const voucherLines = [
    leg('OPERATING_EXPENSE', 'DEBIT', 100),
    leg('MANUAL_NONTRADE_ACCRUAL', 'CREDIT', 100),
  ];

  function stubDb(existing: { sourceKind: string; sourceId: string }) {
    return {
      financeJournalEntry: { findFirst: vi.fn().mockResolvedValue(existing), create: vi.fn() },
      financeJournalLine: { create: vi.fn() },
    };
  }

  function input(overrides: Partial<PostJournalEntryInput> = {}): PostJournalEntryInput {
    return {
      sourceKind: 'PHARMACY_JOURNAL_VOUCHER',
      sourceId: 'voucher_1',
      description: 'Nontrade accrual',
      occurredAt: new Date('2026-10-25T00:00:00Z'),
      idempotencyKey: 'key_1',
      lines: voucherLines,
      ...overrides,
    };
  }

  it('keeps accepting legacy Int32 maximum legs on each side', () => {
    expect(() =>
      assertBalanced([
        leg('OPERATING_EXPENSE', 'DEBIT', 2_147_483_647),
        leg('MANUAL_NONTRADE_ACCRUAL', 'CREDIT', 2_147_483_647),
      ])
    ).not.toThrow();
  });

  it('refuses side totals that leave the safe-integer range', () => {
    expect(() =>
      assertBalanced([
        leg('OPERATING_EXPENSE', 'DEBIT', Number.MAX_SAFE_INTEGER),
        leg('OPERATING_EXPENSE', 'DEBIT', 1),
        leg('MANUAL_NONTRADE_ACCRUAL', 'CREDIT', Number.MAX_SAFE_INTEGER),
        leg('MANUAL_NONTRADE_ACCRUAL', 'CREDIT', 1),
      ])
    ).toThrow(new FinancePostingError('INVALID_AMOUNT'));
  });

  it('preserves legacy replay: a reused key returns the existing entry whatever its source', async () => {
    const existing = { sourceKind: 'PHARMACY_SALE_LINE', sourceId: 'sale_line_1' };
    const db = stubDb(existing);
    await expect(
      postJournalEntry(
        db as never,
        scope,
        input({
          sourceKind: 'PHARMACY_SALE_LINE',
          sourceId: 'sale_line_2',
          lines: [leg('SALES_CLEARING', 'DEBIT', 100), leg('SALES_REVENUE', 'CREDIT', 100)],
        })
      )
    ).resolves.toBe(existing);
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    expect(db.financeJournalLine.create).not.toHaveBeenCalled();
  });

  it('refuses a voucher key reused for a different voucher of the same kind', async () => {
    const db = stubDb({ sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: 'voucher_other' });
    await expect(postJournalEntry(db as never, scope, input())).rejects.toThrow(
      new FinancePostingError('MISSING_SOURCE')
    );
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    expect(db.financeJournalLine.create).not.toHaveBeenCalled();
  });

  it('refuses a voucher key already used by a different source kind with the same id', async () => {
    const db = stubDb({ sourceKind: 'PHARMACY_SALE_LINE', sourceId: 'voucher_1' });
    await expect(postJournalEntry(db as never, scope, input())).rejects.toThrow(
      new FinancePostingError('MISSING_SOURCE')
    );
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    expect(db.financeJournalLine.create).not.toHaveBeenCalled();
  });

  it('replays a voucher once when the key, kind and source match', async () => {
    const existing = { sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: 'voucher_1' };
    const db = stubDb(existing);
    await expect(postJournalEntry(db as never, scope, input())).resolves.toBe(existing);
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    expect(db.financeJournalLine.create).not.toHaveBeenCalled();
  });
});
