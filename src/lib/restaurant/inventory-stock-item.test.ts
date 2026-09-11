import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

import { createStockItem, InventoryError } from './inventory';

const findIngredient = vi.fn();
const findUnit = vi.fn();
const findStockItem = vi.fn();
const insertStockItem = vi.fn();
const db = {
  restaurantIngredient: { findUnique: findIngredient },
  restaurantUnit: { findUnique: findUnit },
  restaurantStockItem: { findUnique: findStockItem, create: insertStockItem },
} as unknown as ScopedDb;

beforeEach(() => {
  vi.clearAllMocks();
  findIngredient.mockResolvedValue({ id: 'ingredient_1', baseUnitId: 'unit_kg' });
  findUnit.mockResolvedValue({ id: 'unit_kg' });
  findStockItem.mockResolvedValue(null);
  insertStockItem.mockResolvedValue({ id: 'stock_item_1' });
});

describe('createStockItem', () => {
  it('creates the ingredient stock identity in its base unit', async () => {
    await expect(
      createStockItem(db, {
        ingredientId: 'ingredient_1',
        canonicalUnitId: 'unit_kg',
        trackBatches: true,
      })
    ).resolves.toEqual({ id: 'stock_item_1' });
    expect(insertStockItem).toHaveBeenCalledWith({
      data: {
        ingredientId: 'ingredient_1',
        canonicalUnitId: 'unit_kg',
        trackBatches: true,
      },
    });
  });

  it('rejects a canonical unit that differs from the ingredient base unit', async () => {
    findUnit.mockResolvedValue({ id: 'unit_piece' });
    await expect(
      createStockItem(db, {
        ingredientId: 'ingredient_1',
        canonicalUnitId: 'unit_piece',
      })
    ).rejects.toEqual(expect.objectContaining<Partial<InventoryError>>({ reason: 'INVALID' }));
    expect(insertStockItem).not.toHaveBeenCalled();
  });
});
