import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { postJournalEntry } from '@/lib/finance/journal';
import { postSaleReturnEntry } from './finance-postings';

vi.mock('@/lib/finance/journal', () => ({
  postJournalEntry: vi.fn(async (_db, _scope, input) => input),
}));

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
              quantity: 1,
              discountMinor: 2,
              canonicalUnits: 3,
            },
          }),
          aggregate: vi.fn().mockResolvedValue({ _sum: { canonicalUnits: through } }),
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
