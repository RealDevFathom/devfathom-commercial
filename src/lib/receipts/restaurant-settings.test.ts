import { describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { DEFAULT_RECEIPT_LAYOUT } from './configuration';
import {
  getRestaurantReceiptLayout,
  listRestaurantReceiptLayouts,
  saveRestaurantReceiptLayout,
} from './restaurant-settings';

describe('receipt layout persistence boundary (mocked, not RLS proof)', () => {
  it('denies unavailable branch reads instead of returning defaults', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const db = { restaurantBranch: { findFirst } } as unknown as ScopedDb;
    await expect(getRestaurantReceiptLayout(db, 'org-a', 'branch-b')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'branch-b', organizationId: 'org-a', active: true } })
    );
  });
  it('scopes reads to active branches in the authenticated organization', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { id: 'branch-a', name: 'A', receiptLayout: null, receiptLayoutRevision: 0 },
      ]);
    const db = { restaurantBranch: { findMany } } as unknown as ScopedDb;
    expect(await listRestaurantReceiptLayouts(db, 'org-a')).toEqual([
      { id: 'branch-a', name: 'A', layout: DEFAULT_RECEIPT_LAYOUT, revision: 0 },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a', active: true } })
    );
  });
  it('atomically scopes writes by organization, branch, active state and revision', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const db = { restaurantBranch: { updateMany } } as unknown as ScopedDb;
    const input = { branchId: 'branch-a', revision: 2, layout: DEFAULT_RECEIPT_LAYOUT };
    expect(await saveRestaurantReceiptLayout(db, 'org-a', input)).toEqual({
      layout: DEFAULT_RECEIPT_LAYOUT,
      revision: 3,
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'branch-a', organizationId: 'org-a', active: true, receiptLayoutRevision: 2 },
      data: { receiptLayout: DEFAULT_RECEIPT_LAYOUT, receiptLayoutRevision: { increment: 1 } },
    });
  });
  it('rejects stale, foreign or inactive branches without revealing existence', async () => {
    const db = {
      restaurantBranch: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as unknown as ScopedDb;
    await expect(
      saveRestaurantReceiptLayout(db, 'org-a', {
        branchId: 'foreign',
        revision: 0,
        layout: DEFAULT_RECEIPT_LAYOUT,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('propagates database errors and rejects invalid input before writing', async () => {
    const failure = new Error('database unavailable');
    const updateMany = vi.fn().mockRejectedValue(failure);
    const db = { restaurantBranch: { updateMany } } as unknown as ScopedDb;
    await expect(saveRestaurantReceiptLayout(db, 'org-a', {})).rejects.toThrow();
    expect(updateMany).not.toHaveBeenCalled();
    await expect(
      saveRestaurantReceiptLayout(db, 'org-a', {
        branchId: 'a',
        revision: 0,
        layout: DEFAULT_RECEIPT_LAYOUT,
      })
    ).rejects.toBe(failure);
  });
});
