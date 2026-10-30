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
