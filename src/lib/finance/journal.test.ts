/**
 * FIN-01 — the pure half of the shared journal: the balance kernel and the sign
 * convention every FIN-03 read folds with.
 *
 * The database-backed guarantees (the deferred balance trigger, append-only,
 * at-most-one reversal, tenant isolation) are in `journal.db.test.ts`; those
 * are claims about PostgreSQL and cannot be shown here.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  ACCOUNT_NORMAL_SIDE,
  assertBalanced,
  FinancePostingError,
  postJournalEntry,
  REPLAY_IDENTITY_CHECKED_SOURCES,
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

describe('CEO-JVCORE-20261025 — journal voucher compatibility', () => {
  function replayDb(existing: Record<string, unknown> | null) {
    return {
      financeJournalEntry: {
        findFirst: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
        findFirstOrThrow: vi.fn(),
      },
      financeJournalLine: { create: vi.fn() },
    };
  }
  const scope = { organizationId: 'org_1', actorId: 'owner_1' };
  const voucherLines = [
    leg('OPERATING_EXPENSE', 'DEBIT', 2_500),
    leg('MANUAL_NONTRADE_ACCRUAL', 'CREDIT', 2_500),
  ];
  const voucherInput = {
    sourceKind: 'PHARMACY_JOURNAL_VOUCHER' as const,
    sourceId: 'jv_1',
    description: 'Journal voucher JV-1',
    occurredAt: new Date('2026-11-10T00:00:00Z'),
    idempotencyKey: 'journal-voucher:jv_1',
    lines: voucherLines,
  };

  it('treats the non-trade accrual as a credit-normal liability', () => {
    expect(ACCOUNT_NORMAL_SIDE.MANUAL_NONTRADE_ACCRUAL).toBe('CREDIT');
    expect(signedMinor(voucherLines[1]!)).toBe(2_500);
    expect(() => assertBalanced(voucherLines)).not.toThrow();
  });

  it('keeps legacy Int32-sized balanced postings valid', () => {
    expect(() =>
      assertBalanced([
        leg('INVENTORY', 'DEBIT', 2_147_483_647),
        leg('CASH', 'CREDIT', 2_147_483_647),
      ])
    ).not.toThrow();
  });

  it('replays a voucher key only for the same voucher source', async () => {
    const same = { id: 'entry_1', sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: 'jv_1' };
    const db = replayDb(same);
    await expect(postJournalEntry(db as unknown as ScopedDb, scope, voucherInput)).resolves.toBe(
      same
    );
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('refuses a voucher key that already belongs to another source row', async () => {
    for (const existing of [
      { id: 'entry_1', sourceKind: 'PHARMACY_JOURNAL_VOUCHER', sourceId: 'jv_other' },
      { id: 'entry_1', sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION', sourceId: 'jv_1' },
    ]) {
      const db = replayDb(existing);
      await expect(
        postJournalEntry(db as unknown as ScopedDb, scope, voucherInput)
      ).rejects.toMatchObject({ reason: 'IDEMPOTENCY_CONFLICT' });
      expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    }
  });

  it('leaves legacy adapters on their existing key-only replay', async () => {
    const existing = { id: 'entry_1', sourceKind: 'PHARMACY_TENDER', sourceId: 'other' };
    const db = replayDb(existing);
    await expect(
      postJournalEntry(db as unknown as ScopedDb, scope, {
        ...voucherInput,
        sourceKind: 'PHARMACY_BOOKKEEPING_TRANSACTION',
        lines: [leg('OPERATING_EXPENSE', 'DEBIT', 10), leg('BANK', 'CREDIT', 10)],
      })
    ).resolves.toBe(existing);
    expect(REPLAY_IDENTITY_CHECKED_SOURCES.has('PHARMACY_BOOKKEEPING_TRANSACTION')).toBe(false);
  });
});
