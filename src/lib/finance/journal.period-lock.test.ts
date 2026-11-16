import { describe, expect, it, vi } from 'vitest';
import { FinanceSourceKind } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { postJournalEntry, reverseJournalEntry, type PostJournalEntryInput } from './journal';

const scope = { organizationId: 'org_a', actorId: 'cashier' };
const startsAt = new Date('2026-11-01T00:00:00Z');
const endsAt = new Date('2026-12-01T00:00:00Z');
const input: PostJournalEntryInput = {
  sourceKind: 'PHARMACY_SALE_LINE',
  sourceId: 'sale_line',
  description: 'Counter sale',
  branchId: 'branch_a',
  occurredAt: startsAt,
  idempotencyKey: 'sale_line',
  lines: [
    { accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 5000 },
    { accountCode: 'SALES_REVENUE', side: 'CREDIT', amountMinor: 5000 },
  ],
};

function fixture(options: { replay?: boolean; periodBranch?: string; status?: string } = {}) {
  const calls: string[] = [];
  const original = { id: 'original', ...input, ...scope, currency: 'PKR', lines: input.lines };
  const db = {
    $queryRaw: vi.fn(async (sql: { values: unknown[] }) => {
      calls.push(`lock:${sql.values[0]}`);
      return [];
    }),
    pharmacyAccountingPeriod: {
      findFirst: vi.fn(async ({ where }) => {
        calls.push(`period:${where.branchId}`);
        return where.organizationId === scope.organizationId &&
          where.branchId === (options.periodBranch ?? 'branch_a') &&
          (options.status ?? 'CLOSED') === where.status &&
          startsAt <= where.startsAt.lte &&
          endsAt > where.endsAt.gt
          ? { id: 'closed' }
          : null;
      }),
    },
    financeJournalEntry: {
      findFirst: vi.fn(async ({ where }) =>
        where.id === 'original' || options.replay ? original : null
      ),
      create: vi.fn(async ({ data }) => {
        calls.push('create');
        return { id: 'new', ...data };
      }),
      findFirstOrThrow: vi.fn(async () => ({ id: 'new', lines: input.lines })),
    },
    financeJournalLine: { create: vi.fn() },
  };
  return { db, scoped: db as unknown as ScopedDb, calls };
}

describe('DEV-877 operational accounting period lock', () => {
  it.each(Object.values(FinanceSourceKind))(
    'refuses %s in a closed period before writing',
    async (sourceKind) => {
      const { db, scoped } = fixture();
      await expect(postJournalEntry(scoped, scope, { ...input, sourceKind })).rejects.toMatchObject(
        { reason: 'PERIOD_CLOSED' }
      );
      expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
      expect(db.financeJournalLine.create).not.toHaveBeenCalled();
    }
  );

  it('checks the historical posting date used by offline replay', async () => {
    const { db, scoped } = fixture();
    await expect(
      postJournalEntry(scoped, scope, { ...input, occurredAt: new Date('2026-11-16T08:00:00Z') })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(db.pharmacyAccountingPeriod.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: scope.organizationId,
        branchId: 'branch_a',
        status: 'CLOSED',
        startsAt: { lte: new Date('2026-11-16T08:00:00Z') },
        endsAt: { gt: new Date('2026-11-16T08:00:00Z') },
      },
      select: { id: true },
    });
  });

  it.each([new Date(startsAt.getTime() - 1), endsAt])(
    'allows the open side of the half-open boundary %s',
    async (occurredAt) => {
      const { db, scoped } = fixture();
      await expect(
        postJournalEntry(scoped, scope, { ...input, occurredAt })
      ).resolves.toMatchObject({ id: 'new' });
      expect(db.financeJournalEntry.create).toHaveBeenCalledOnce();
    }
  );

  it.each([{ periodBranch: 'other_branch' }, { status: 'REOPENED' }])(
    'keeps an open or reopened branch usable (%j)',
    async (options) => {
      const { scoped } = fixture(options);
      await expect(postJournalEntry(scoped, scope, input)).resolves.toMatchObject({ id: 'new' });
    }
  );

  it('locks all affected transfer branches in sorted order before checking either period', async () => {
    const { scoped, calls, db } = fixture({ periodBranch: 'branch_z' });
    await expect(
      postJournalEntry(scoped, scope, {
        ...input,
        branchId: 'branch_z',
        sourceKind: 'PHARMACY_INTERBRANCH_TRANSFER_LINE',
        lines: input.lines.map((line) => ({ ...line, branchId: 'branch_a' })),
      })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(calls).toEqual([
      'lock:pharmacy-ledger:org_a:branch_a',
      'lock:pharmacy-ledger:org_a:branch_z',
      'period:branch_a',
      'period:branch_z',
    ]);
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('checks line branches even when the entry header has no branch', async () => {
    const { scoped } = fixture();
    await expect(
      postJournalEntry(scoped, scope, {
        ...input,
        branchId: null,
        lines: input.lines.map((line) => ({ ...line, branchId: 'branch_a' })),
      })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
  });

  it('does not write or refuse an already committed idempotent replay after closing', async () => {
    const { scoped, db } = fixture({ replay: true });
    await expect(postJournalEntry(scoped, scope, input)).resolves.toMatchObject({ id: 'original' });
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    expect(db.pharmacyAccountingPeriod.findFirst).not.toHaveBeenCalled();
  });

  it('refuses a new reversal dated in a closed period', async () => {
    const { scoped, db } = fixture();
    await expect(
      reverseJournalEntry(scoped, scope, {
        entryId: 'original',
        at: startsAt,
        reason: 'Correction',
        idempotencyKey: 'reverse',
      })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    expect(db.financeJournalLine.create).not.toHaveBeenCalled();
  });
});
