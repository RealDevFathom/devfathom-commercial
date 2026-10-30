import { beforeEach, describe, expect, it, vi } from 'vitest';

import { assertBalanced, postJournalEntry } from '@/lib/finance/journal';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  postCountAdjustmentEntry,
  postGoodsReceiptEntry,
  postInterbranchTransferEntry,
  postOpeningLedgerEntry,
  postOpeningStockEntry,
} from './finance-postings';

vi.mock('@/lib/finance/journal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/finance/journal')>()),
  postJournalEntry: vi.fn(async (_db, _scope, input) => input),
}));

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
const at = new Date('2026-09-01T00:00:00Z');
const scoped = (db: object) => db as ScopedDb;

beforeEach(() => vi.clearAllMocks());

describe('zero-cost stock remains operational without empty journal entries', () => {
  it('accepts an all-bonus receipt', async () => {
    const db = scoped({
      pharmacyGoodsReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'receipt',
          branchId: scope.branchId,
          status: 'POSTED',
          lines: [
            {
              inventoryLotId: 'lot',
              unitCostMinor: 0,
              acceptedCanonicalUnits: 10,
              rejectedCanonicalUnits: 0,
            },
          ],
        }),
      },
    });
    await expect(
      postGoodsReceiptEntry(db, scope, { goodsReceiptId: 'receipt', at })
    ).resolves.toBeNull();
    expect(postJournalEntry).not.toHaveBeenCalled();
    await expect(
      postGoodsReceiptEntry(
        db,
        { ...scope, branchId: 'other' },
        {
          goodsReceiptId: 'receipt',
          at,
        }
      )
    ).rejects.toMatchObject({ reason: 'CROSS_BRANCH_REFERENCE' });
  });

  it.each([-2, 2])('accepts a count variance of %i on a zero-cost lot', async (varianceUnits) => {
    const db = scoped({
      pharmacyInventoryCountLine: {
        findFirst: vi.fn().mockResolvedValue({
          branchId: scope.branchId,
          inventoryLotId: 'lot',
          varianceUnits,
          count: { status: 'APPROVED' },
        }),
      },
      pharmacyInventoryLot: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'lot', unitCostMinor: 0, batch: { medicineId: 'medicine' } }]),
      },
    });
    await expect(
      postCountAdjustmentEntry(db, scope, { countLineId: 'line', at })
    ).resolves.toBeNull();
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('dispatches a zero-cost transfer without a monetary posting', async () => {
    const db = scoped({
      pharmacyInterbranchTransferLine: {
        findFirst: vi.fn().mockResolvedValue({
          sourceBranchId: scope.branchId,
          sourceLotId: 'lot',
          quantityUnits: 10,
        }),
      },
      pharmacyInventoryLot: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'lot', unitCostMinor: 0, batch: { medicineId: 'medicine' } }]),
      },
    });
    await expect(
      postInterbranchTransferEntry(db, scope, { transferLineId: 'line', at })
    ).resolves.toBeNull();
    expect(postJournalEntry).not.toHaveBeenCalled();
  });
});

describe('stock values fit the journal integer columns', () => {
  function expectPosting(total: number) {
    const input = vi.mocked(postJournalEntry).mock.calls[0][2];
    assertBalanced(input.lines);
    expect(input.lines.every((line) => line.amountMinor <= 2_147_483_647)).toBe(true);
    for (const side of ['DEBIT', 'CREDIT']) {
      expect(
        input.lines
          .filter((line) => line.side === side)
          .reduce((sum, line) => sum + line.amountMinor, 0)
      ).toBe(total);
    }
    return input.lines;
  }

  it.each([1, 2])(
    'splits receipt values across %i receipt lines, retaining dimensions',
    async (lineCount) => {
      const db = scoped({
        pharmacyGoodsReceipt: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'receipt',
            branchId: scope.branchId,
            status: 'POSTED',
            lines: Array.from({ length: lineCount }, (_, i) => ({
              id: `line-${i}`,
              medicineId: 'medicine',
              inventoryLotId: `lot-${i}`,
              stockLocationId: 'store',
              quarantineLocationId: 'quarantine',
              unitCostMinor: 500_000_000,
              acceptedCanonicalUnits: 6 / lineCount,
              rejectedCanonicalUnits: 2,
            })),
          }),
        },
      });
      await postGoodsReceiptEntry(db, scope, { goodsReceiptId: 'receipt', at });
      const lines = expectPosting((3 + lineCount) * 1_000_000_000);
      for (let i = 0; i < lineCount; i++) {
        const inventory = lines.filter((line) => line.sourceLineId === `line-${i}`);
        expect(
          inventory.every((line) => line.lotId === `lot-${i}` && line.productId === 'medicine')
        ).toBe(true);
        expect(
          inventory
            .filter((line) => line.locationId === 'store')
            .reduce((sum, line) => sum + line.amountMinor, 0)
        ).toBe(3_000_000_000 / lineCount);
        expect(
          inventory
            .filter((line) => line.locationId === 'quarantine')
            .reduce((sum, line) => sum + line.amountMinor, 0)
        ).toBe(1_000_000_000);
      }
    }
  );

  it.each([-3, 3])(
    'splits count variance %i without losing its sign or dimensions',
    async (varianceUnits) => {
      const db = scoped({
        pharmacyInventoryCountLine: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'line',
            branchId: scope.branchId,
            inventoryLotId: 'lot',
            stockLocationId: 'store',
            varianceUnits,
            count: { status: 'APPROVED' },
          }),
        },
        pharmacyInventoryLot: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { id: 'lot', unitCostMinor: 1_000_000_000, batch: { medicineId: 'medicine' } },
            ]),
        },
      });
      await postCountAdjustmentEntry(db, scope, { countLineId: 'line', at });
      const lines = expectPosting(3_000_000_000);
      expect(
        lines.every(
          (line) =>
            line.branchId === scope.branchId &&
            line.lotId === 'lot' &&
            line.locationId === 'store' &&
            line.sourceLineId === 'line'
        )
      ).toBe(true);
      expect(
        lines
          .filter((line) => line.accountCode === 'INVENTORY')
          .every((line) => line.side === (varianceUnits > 0 ? 'DEBIT' : 'CREDIT'))
      ).toBe(true);
    }
  );

  it('splits a transfer value while retaining each branch and location', async () => {
    const db = scoped({
      pharmacyInterbranchTransferLine: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'line',
          sourceBranchId: scope.branchId,
          sourceLotId: 'lot',
          quantityUnits: 3,
          sourceStockLocationId: 'store',
          destinationStockLocationId: 'destination',
          transfer: { toBranchId: 'other' },
        }),
      },
      pharmacyInventoryLot: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'lot', unitCostMinor: 1_000_000_000, batch: { medicineId: 'medicine' } },
          ]),
      },
    });
    await postInterbranchTransferEntry(db, scope, { transferLineId: 'line', at });
    const lines = expectPosting(3_000_000_000);
    expect(lines.every((line) => line.lotId === 'lot' && line.sourceLineId === 'line')).toBe(true);
    expect(
      lines
        .filter((line) => line.side === 'CREDIT')
        .every((line) => line.branchId === scope.branchId && line.locationId === 'store')
    ).toBe(true);
    expect(
      lines
        .filter((line) => line.side === 'DEBIT')
        .every((line) => line.branchId === 'other' && line.locationId === 'destination')
    ).toBe(true);
  });
});

describe('opening balances fit the journal integer columns', () => {
  it.each([1, 2_147_483_647, 2_147_483_648, 5_000_000_001])(
    'posts an opening inventory value of %i exactly',
    async (value) => {
      const db = scoped({
        pharmacyOpeningTotal: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'total',
            sessionId: 'session',
            branchId: scope.branchId,
            totalValueMinor: BigInt(value),
          }),
        },
      });
      await postOpeningStockEntry(db, scope, { sessionId: 'session', at });
      const input = vi.mocked(postJournalEntry).mock.calls[0][2];
      assertBalanced(input.lines);
      expect(input.lines.every((line) => line.amountMinor <= 2_147_483_647)).toBe(true);
      expect(
        input.lines
          .filter((line) => line.accountCode === 'INVENTORY')
          .reduce((sum, line) => sum + BigInt(line.amountMinor), BigInt(0))
      ).toBe(BigInt(value));
    }
  );

  it.each([5_000_000_001, -5_000_000_001])(
    'preserves the sign of an opening balance of %i',
    async (value) => {
      const db = scoped({
        pharmacyOpeningLedgerEntry: {
          findFirst: vi.fn().mockResolvedValue({
            id: 'opening',
            branchId: scope.branchId,
            account: 'BANK',
            sourceRef: 'legacy',
            balanceMinor: BigInt(value),
          }),
        },
      });
      await postOpeningLedgerEntry(db, scope, { openingLedgerEntryId: 'opening', at });
      const input = vi.mocked(postJournalEntry).mock.calls[0][2];
      assertBalanced(input.lines);
      expect(input.lines.every((line) => line.amountMinor <= 2_147_483_647)).toBe(true);
      const bank = input.lines.filter((line) => line.accountCode === 'BANK');
      expect(bank.every((line) => line.side === (value > 0 ? 'DEBIT' : 'CREDIT'))).toBe(true);
      expect(bank.reduce((sum, line) => sum + BigInt(line.amountMinor), BigInt(0))).toBe(
        BigInt(Math.abs(value))
      );
    }
  );
});
