import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { postGoodsReceiptEntry, reversePostingForSource } from './finance-postings';
import { reverseGoodsReceipt } from './goods-receipt';
import { reverseMovements } from './stock-ledger';

vi.mock('./finance-postings', () => ({
  postGoodsReceiptEntry: vi.fn(),
  reversePostingForSource: vi.fn(),
}));
vi.mock('./stock-ledger', () => ({ reverseMovements: vi.fn() }));

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
const postedAt = new Date('2026-09-01T00:00:00Z');
const at = new Date('2026-09-02T00:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reverseMovements).mockResolvedValue([{ id: 'reversal-movement' }] as never);
});

describe('goods receipt reversal accounting', () => {
  it.each([true, false])('reverses stock when a monetary entry exists: %s', async (hasValue) => {
    vi.mocked(postGoodsReceiptEntry).mockResolvedValue(
      hasValue ? ({ id: 'original' } as never) : null
    );
    const db = {
      pharmacyGoodsReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'receipt',
          branchId: scope.branchId,
          status: 'POSTED',
          postedAt,
          lines: [{ id: 'line' }],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      pharmacyStockMovement: { findMany: vi.fn().mockResolvedValue([{ id: 'movement' }]) },
    };
    const result = await reverseGoodsReceipt(db as unknown as ScopedDb, scope, {
      goodsReceiptId: 'receipt',
      reason: 'Returned delivery',
      at,
    });
    expect(postGoodsReceiptEntry).toHaveBeenCalledWith(db, scope, {
      goodsReceiptId: 'receipt',
      at: postedAt,
    });
    expect(vi.mocked(postGoodsReceiptEntry).mock.invocationCallOrder[0]).toBeLessThan(
      db.pharmacyGoodsReceipt.update.mock.invocationCallOrder[0]
    );
    expect(reverseMovements).toHaveBeenCalledWith(db, scope, {
      movementIds: ['movement'],
      reason: 'Returned delivery',
      at,
    });
    expect(result.reversalMovementIds).toEqual(['reversal-movement']);
    if (hasValue) {
      expect(reversePostingForSource).toHaveBeenCalledWith(db, scope, {
        sourceKind: 'PHARMACY_GOODS_RECEIPT',
        sourceId: 'receipt',
        reason: 'Returned delivery',
        at,
      });
    } else {
      expect(reversePostingForSource).not.toHaveBeenCalled();
    }
  });
});
