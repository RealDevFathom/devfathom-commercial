import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { postJournalEntry } from '@/lib/finance/journal';
import { postSaleReturnEntry, postUnidentifiedSaleReturnEntry } from './finance-postings';

vi.mock('@/lib/finance/journal', () => ({
  postJournalEntry: vi.fn(async (_db, _scope, input) => input),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('return postings match authorized cumulative net', () => {
  it.each([
    [1, 1, 33, 0, 33],
    [3, 2, 69, 2, 67],
    [2, 2, 67, 1, 66],
    [3, 1, 35, 1, 34],
  ])(
    'through %i, returned %i: gross %i discount %i net %i',
    async (through, units, gross, discount, net) => {
      const db = {
        pharmacySaleReturnLine: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'return',
            branchId: 'branch',
            inventoryLotId: 'lot',
            stockLocationId: 'store',
            canonicalUnits: units,
            saleLine: {
              id: 'line',
              medicineId: 'medicine',
              unitPriceMinor: 102,
              grossMinor: 102,
              quantity: 1,
              discountMinor: 2,
              canonicalUnits: 3,
            },
          }),
          aggregate: vi.fn().mockResolvedValue({ _sum: { canonicalUnits: through } }),
        },
        pharmacyUnidentifiedReturnHold: {
          aggregate: vi.fn().mockResolvedValue({ _sum: { canonicalUnits: 0 } }),
        },
        financeJournalEntry: { findFirst: vi.fn().mockResolvedValue(null) },
        pharmacyInventoryLot: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: 'lot', unitCostMinor: 2, batch: { medicineId: 'medicine' } },
            ]),
        },
      };
      await postSaleReturnEntry(
        db as unknown as ScopedDb,
        { organizationId: 'org', branchId: 'branch', actorId: 'actor' },
        { saleReturnLineId: 'return', at: new Date('2026-09-05') }
      );
      const posted = vi.mocked(postJournalEntry).mock.calls.at(-1)![2];
      const amount = (account: string) =>
        posted.lines
          .filter((row) => row.accountCode === account)
          .reduce(
            (sum, row) => sum + (row.side === 'DEBIT' ? row.amountMinor : -row.amountMinor),
            0
          );
      expect(amount('SALES_CLEARING')).toBe(-net);
      expect(amount('SALES_REVENUE')).toBe(gross);
      expect(amount('SALES_DISCOUNT')).toBe(0 - discount);
      expect(amount('COST_OF_GOODS_SOLD')).toBe(-units * 2);
      expect(amount('INVENTORY')).toBe(units * 2);
      const calls = vi.mocked(postJournalEntry).mock.calls.length;
      db.financeJournalEntry.findFirst.mockResolvedValue(posted);
      await postSaleReturnEntry(
        db as unknown as ScopedDb,
        { organizationId: 'org', branchId: 'branch', actorId: 'actor' },
        { saleReturnLineId: 'return', at: new Date('2026-09-05') }
      );
      expect(vi.mocked(postJournalEntry).mock.calls).toHaveLength(calls);
    }
  );
});

it('reverses revenue but not inventory for an unidentified return hold', async () => {
  const db = {
    pharmacyUnidentifiedReturnHold: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'hold',
        branchId: 'branch',
        quarantineLocationId: 'quarantine',
        canonicalUnits: 2,
        saleLine: {
          id: 'line',
          medicineId: 'medicine',
          unitPriceMinor: 102,
          grossMinor: 102,
          quantity: 1,
          discountMinor: 2,
          canonicalUnits: 3,
          returnLines: [],
          unidentifiedReturnHolds: [{ canonicalUnits: 2 }],
        },
      }),
    },
    financeJournalEntry: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  await postUnidentifiedSaleReturnEntry(
    db as unknown as ScopedDb,
    { organizationId: 'org', branchId: 'branch', actorId: 'actor' },
    { holdingId: 'hold', at: new Date('2026-10-21') }
  );
  const posted = vi.mocked(postJournalEntry).mock.calls.at(-1)![2];
  expect(posted).toMatchObject({
    sourceKind: 'PHARMACY_UNIDENTIFIED_RETURN_HOLD',
    sourceId: 'hold',
  });
  expect(posted.lines).toEqual([
    expect.objectContaining({ accountCode: 'SALES_REVENUE', side: 'DEBIT', amountMinor: 67 }),
    expect.objectContaining({ accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 67 }),
    expect.objectContaining({ accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 1 }),
    expect.objectContaining({ accountCode: 'SALES_DISCOUNT', side: 'CREDIT', amountMinor: 1 }),
  ]);
  expect(posted.lines.some((line) => line.accountCode === 'INVENTORY')).toBe(false);
  expect(posted.lines.some((line) => line.accountCode === 'COST_OF_GOODS_SOLD')).toBe(false);
  expect(
    posted.lines.reduce(
      (balance, line) => balance + (line.side === 'DEBIT' ? line.amountMinor : -line.amountMinor),
      0
    )
  ).toBe(0);
  expect(db.pharmacyUnidentifiedReturnHold.findFirst).toHaveBeenCalledWith({
    where: { id: 'hold', organizationId: 'org' },
    include: {
      saleLine: { include: { returnLines: true, unidentifiedReturnHolds: true } },
    },
  });
  expect(db.financeJournalEntry.findFirst).toHaveBeenCalledWith({
    where: {
      organizationId: 'org',
      idempotencyKey: 'finance:PHARMACY_UNIDENTIFIED_RETURN_HOLD:hold',
    },
    include: { lines: { orderBy: { id: 'asc' } } },
  });
  const postingCalls = vi.mocked(postJournalEntry).mock.calls.length;
  db.financeJournalEntry.findFirst.mockResolvedValue(posted);
  await postUnidentifiedSaleReturnEntry(
    db as unknown as ScopedDb,
    { organizationId: 'org', branchId: 'branch', actorId: 'actor' },
    { holdingId: 'hold', at: new Date('2026-10-21') }
  );
  expect(vi.mocked(postJournalEntry).mock.calls).toHaveLength(postingCalls);
});

it('rejects an unidentified return from another branch before posting', async () => {
  const db = {
    pharmacyUnidentifiedReturnHold: {
      findFirst: vi.fn().mockResolvedValue({ id: 'hold', branchId: 'other-branch' }),
    },
  };

  await expect(
    postUnidentifiedSaleReturnEntry(
      db as unknown as ScopedDb,
      { organizationId: 'org', branchId: 'branch', actorId: 'actor' },
      { holdingId: 'hold', at: new Date('2026-10-21') }
    )
  ).rejects.toThrow('CROSS_BRANCH_REFERENCE');
  expect(postJournalEntry).not.toHaveBeenCalled();
});

it('does not post an unidentified return outside the organization scope', async () => {
  const db = {
    pharmacyUnidentifiedReturnHold: { findFirst: vi.fn().mockResolvedValue(null) },
    financeJournalEntry: { findFirst: vi.fn() },
  };

  await expect(
    postUnidentifiedSaleReturnEntry(
      db as unknown as ScopedDb,
      { organizationId: 'org', branchId: 'branch', actorId: 'actor' },
      { holdingId: 'other-org-hold', at: new Date('2026-10-21') }
    )
  ).rejects.toThrow('NOT_FOUND');
  expect(db.pharmacyUnidentifiedReturnHold.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: 'other-org-hold', organizationId: 'org' } })
  );
  expect(db.financeJournalEntry.findFirst).not.toHaveBeenCalled();
  expect(postJournalEntry).not.toHaveBeenCalled();
});

it('records a zero-minor-unit slice and assigns the rounding remainder to a later hold', async () => {
  const saleLine = {
    id: 'line',
    medicineId: 'medicine',
    unitPriceMinor: 1,
    grossMinor: 1,
    quantity: 1,
    discountMinor: 0,
    canonicalUnits: 3,
    returnLines: [],
    unidentifiedReturnHolds: [{ canonicalUnits: 1 }],
  };
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce({
      id: 'early-hold',
      branchId: 'branch',
      quarantineLocationId: 'quarantine',
      canonicalUnits: 1,
      saleLine,
    })
    .mockResolvedValueOnce({
      id: 'later-hold',
      branchId: 'branch',
      quarantineLocationId: 'quarantine',
      canonicalUnits: 2,
      saleLine: {
        ...saleLine,
        unidentifiedReturnHolds: [{ canonicalUnits: 1 }, { canonicalUnits: 2 }],
      },
    });
  const db = {
    pharmacyUnidentifiedReturnHold: { findFirst },
    financeJournalEntry: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ScopedDb;
  const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };

  await postUnidentifiedSaleReturnEntry(db, scope, {
    holdingId: 'early-hold',
    at: new Date('2026-10-21T10:00:00Z'),
  });
  const early = vi.mocked(postJournalEntry).mock.calls.at(-1)![2];
  expect(early.lines).toEqual([
    expect.objectContaining({ accountCode: 'SALES_CLEARING', side: 'DEBIT', amountMinor: 1 }),
    expect.objectContaining({ accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 1 }),
  ]);

  await postUnidentifiedSaleReturnEntry(db, scope, {
    holdingId: 'later-hold',
    at: new Date('2026-10-21T11:00:00Z'),
  });
  const later = vi.mocked(postJournalEntry).mock.calls.at(-1)![2];
  expect(later.lines).toEqual([
    expect.objectContaining({ accountCode: 'SALES_REVENUE', side: 'DEBIT', amountMinor: 1 }),
    expect.objectContaining({ accountCode: 'SALES_CLEARING', side: 'CREDIT', amountMinor: 1 }),
  ]);
});
