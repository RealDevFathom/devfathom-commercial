import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { journalDisplayContext } from './journal-display-context';
import { financialStatements } from '../financial-statements';

const scope = { organizationId: 'org', branchId: 'branch' };
const kinds = [
  'PHARMACY_SALE_LINE',
  'PHARMACY_TENDER',
  'PHARMACY_REFUND',
  'PHARMACY_SALE_RETURN_LINE',
  'PHARMACY_UNIDENTIFIED_RETURN_HOLD',
];
const entries = kinds.map((sourceKind) => ({ sourceKind, sourceId: 'same-id', actorId: 'user' }));

function fixture() {
  const direct = (receiptNumber: number | null) => ({
    findMany: vi.fn().mockResolvedValue([{ id: 'same-id', sale: { receiptNumber } }]),
  });
  const returned = (receiptNumber: number) => ({
    findMany: vi.fn().mockResolvedValue([{ id: 'same-id', saleLine: { sale: { receiptNumber } } }]),
  });
  return {
    pharmacySaleLine: direct(41),
    pharmacyTender: direct(42),
    pharmacyRefund: direct(43),
    pharmacySaleReturnLine: returned(44),
    pharmacyUnidentifiedReturnHold: returned(45),
    user: { findMany: vi.fn().mockResolvedValue([{ id: 'user', name: 'Saad' }]) },
    financeJournalEntry: {
      findMany: vi.fn().mockResolvedValue(entries),
      count: vi.fn().mockResolvedValue(5),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

describe('authorized journal display context', () => {
  it('resolves every sale event and reversal without confusing IDs across source tables', async () => {
    const db = fixture();
    const result = await journalDisplayContext(db as unknown as ScopedDb, scope, [
      ...entries,
      { ...entries[0]!, reversesEntryId: 'original', actorId: 'reversing-user' },
    ]);
    expect(result.map((entry) => entry.billNumber)).toEqual([41, 42, 43, 44, 45, 41]);
    expect(result.slice(0, 5).map((entry) => entry.userName)).toEqual(Array(5).fill('Saad'));
    expect(result[5]!.userName).toBeNull();
    for (const model of [
      db.pharmacySaleLine,
      db.pharmacyTender,
      db.pharmacyRefund,
      db.pharmacySaleReturnLine,
      db.pharmacyUnidentifiedReturnHold,
    ]) {
      expect(model.findMany).toHaveBeenCalledTimes(1);
      expect(model.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ...scope,
            id: { in: expect.arrayContaining(['same-id']) },
          }),
        })
      );
    }
    expect(db.pharmacySaleReturnLine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ saleLine: scope }),
      })
    );
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org', id: { in: ['user', 'reversing-user'] } },
      select: { id: true, name: true },
    });
  });

  it('keeps missing, out-of-scope and unnumbered historical sources unavailable', async () => {
    const db = fixture();
    db.pharmacySaleLine.findMany.mockResolvedValue([
      { id: 'same-id', sale: { receiptNumber: null } },
    ]);
    db.pharmacyTender.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
    const input = [
      entries[0]!,
      entries[1]!,
      { sourceKind: 'PHARMACY_OPENING_STOCK', sourceId: 'internal', actorId: 'system' },
    ];
    expect(await journalDisplayContext(db as unknown as ScopedDb, scope, input)).toEqual(
      input.map((entry) => ({ ...entry, billNumber: null, userName: null }))
    );
    expect(db.pharmacyRefund.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySaleReturnLine.findMany).not.toHaveBeenCalled();
    expect(db.pharmacyUnidentifiedReturnHold.findMany).not.toHaveBeenCalled();
  });

  it('does not read context for an empty page', async () => {
    const db = fixture();
    expect(await journalDisplayContext(db as unknown as ScopedDb, scope, [])).toEqual([]);
    expect(db.user.findMany).not.toHaveBeenCalled();
    expect(db.pharmacySaleLine.findMany).not.toHaveBeenCalled();
  });

  it('enriches the paginated statement reader without changing original evidence', async () => {
    const db = fixture();
    const from = new Date('2026-11-03T00:00:00Z');
    const to = new Date('2026-11-05T00:00:00Z');
    const result = await financialStatements(db as unknown as ScopedDb, scope, {
      from,
      to,
      page: 2,
    });
    expect(result.journal).toEqual(
      entries.map((entry, index) => ({ ...entry, billNumber: 41 + index, userName: 'Saad' }))
    );
    expect(db.financeJournalEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org', occurredAt: { gte: from, lt: to }, lines: { some: scope } },
        take: 25,
        skip: 25,
        select: expect.objectContaining({
          actorId: true,
          sourceId: true,
          sourceKind: true,
          description: true,
        }),
      })
    );
  });
});
