import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import type { FinanceSourceKind } from '@/generated/prisma/client';
import { postJournalEntry, reverseJournalEntry } from './journal';

const scope = { organizationId: 'org_a', actorId: 'cashier' };
const at = new Date('2026-11-16T12:00:00Z');
const lines = [
  { accountCode: 'CASH' as const, side: 'DEBIT' as const, amountMinor: 5000 },
  { accountCode: 'SALES_CLEARING' as const, side: 'CREDIT' as const, amountMinor: 5000 },
];
const input = {
  sourceKind: 'PHARMACY_TENDER' as FinanceSourceKind,
  sourceId: 'source',
  description: 'Payment',
  occurredAt: at,
  idempotencyKey: 'payment',
  branchId: 'branch_a',
  lines,
};
function fixture(closed = true) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyAccountingPeriod: {
      findFirst: vi.fn().mockResolvedValue(closed ? { id: 'period' } : null),
    },
    financeJournalEntry: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'entry' }),
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: 'entry', lines }),
    },
    financeJournalLine: { create: vi.fn() },
  };
}

describe('DEV-877 shared operational period guard', () => {
  it.each<FinanceSourceKind>([
    'PHARMACY_SALE_LINE',
    'PHARMACY_TENDER',
    'PHARMACY_REFUND',
    'PHARMACY_GOODS_RECEIPT',
    'PHARMACY_STOCK_WRITE_OFF',
    'PHARMACY_INTERBRANCH_TRANSFER_LINE',
    'PHARMACY_INVENTORY_COUNT_LINE',
    'PHARMACY_OPENING_STOCK',
    'PHARMACY_OPENING_LEDGER',
  ])('refuses %s before writing any journal rows', async (sourceKind) => {
    const db = fixture();
    await expect(
      postJournalEntry(db as unknown as ScopedDb, scope, { ...input, sourceKind })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
    expect(db.financeJournalLine.create).not.toHaveBeenCalled();
  });

  it('locks before checking the tenant, branch and half-open occurrence window', async () => {
    const db = fixture(false);
    await postJournalEntry(db as unknown as ScopedDb, scope, input);
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyAccountingPeriod.findFirst.mock.invocationCallOrder[0]!
    );
    expect(db.pharmacyAccountingPeriod.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: scope.organizationId,
        branchId: 'branch_a',
        status: 'CLOSED',
        startsAt: { lte: at },
        endsAt: { gt: at },
      },
      select: { id: true },
    });
    expect(db.financeJournalLine.create).toHaveBeenCalledTimes(2);
  });

  it('checks backdated offline occurrence time, not server replay time', async () => {
    const db = fixture();
    const issuedAt = new Date('2026-10-15T12:00:00Z');
    await expect(
      postJournalEntry(db as unknown as ScopedDb, scope, { ...input, occurredAt: issuedAt })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(db.pharmacyAccountingPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ startsAt: { lte: issuedAt }, endsAt: { gt: issuedAt } }),
      })
    );
  });

  it('checks line branches as well as the entry branch, locking in stable order', async () => {
    const db = fixture(false);
    db.pharmacyAccountingPeriod.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'closed_destination' });
    await expect(
      postJournalEntry(db as unknown as ScopedDb, scope, {
        ...input,
        lines: lines.map((line) => ({ ...line, branchId: 'branch_z' })),
      })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(
      db.pharmacyAccountingPeriod.findFirst.mock.calls.map(([args]) => args.where.branchId)
    ).toEqual(['branch_a', 'branch_z']);
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('returns an already posted replay unchanged after close', async () => {
    const db = fixture();
    const existing = { id: 'original', ...input };
    db.financeJournalEntry.findFirst.mockResolvedValue(existing);
    await expect(postJournalEntry(db as unknown as ScopedDb, scope, input)).resolves.toBe(existing);
    expect(db.pharmacyAccountingPeriod.findFirst).not.toHaveBeenCalled();
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });

  it('refuses a new reversal dated in the closed period', async () => {
    const db = fixture();
    db.financeJournalEntry.findFirst
      .mockResolvedValueOnce({ id: 'original', ...input })
      .mockResolvedValueOnce(null);
    await expect(
      reverseJournalEntry(db as unknown as ScopedDb, scope, {
        entryId: 'original',
        reason: 'Returned',
        at,
        idempotencyKey: 'reverse',
      })
    ).rejects.toMatchObject({ reason: 'PERIOD_CLOSED' });
    expect(db.financeJournalEntry.create).not.toHaveBeenCalled();
  });
});
