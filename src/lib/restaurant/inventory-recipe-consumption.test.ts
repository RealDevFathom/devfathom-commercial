import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const mocks = vi.hoisted(() => ({
  explodeRecipeInDb: vi.fn(),
  postStockMovements: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('./recipe-costing', () => ({ explodeRecipeInDb: mocks.explodeRecipeInDb }));
vi.mock('./inventory-ledger', () => ({
  deriveBalance: vi.fn(),
  deriveBalances: vi.fn(),
  postStockMovements: mocks.postStockMovements,
  runStockTransaction: vi.fn(),
}));

import { postOrderRecipeConsumption } from './inventory';

const D = (value: string) => new Prisma.Decimal(value);

function makeDb() {
  return {
    restaurantStockLocation: {
      findFirst: vi.fn(async () => ({ id: 'location-1' })),
    },
    restaurantRecipe: {
      findFirst: vi.fn(async ({ where }: { where: { productId: string } }) => ({
        id: `recipe-${where.productId}`,
        organizationId: 'organization-1',
      })),
    },
    restaurantRecipeVersion: {
      findMany: vi.fn(async ({ where }: { where: { recipeId: string } }) => [
        { id: `version-${where.recipeId}`, status: 'ACTIVE' },
      ]),
    },
  } as unknown as ScopedDb;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.postStockMovements.mockResolvedValue({ movements: [], replayed: false });
});

describe('postOrderRecipeConsumption cancellation movements', () => {
  it('posts exact negative WASTAGE quantities for every tracked recipe leaf in one call', async () => {
    const db = makeDb();
    const now = new Date('2026-10-26T12:34:56.000Z');
    mocks.explodeRecipeInDb.mockResolvedValue({
      ingredients: [
        {
          ingredientId: 'ingredient-flour',
          ingredientName: 'Flour',
          baseUnitId: 'unit-gram',
          stockItemId: 'stock-flour',
          quantityInBaseUnit: D('0.2469135780246913578'),
        },
        {
          ingredientId: 'ingredient-oil',
          ingredientName: 'Oil',
          baseUnitId: 'unit-litre',
          stockItemId: 'stock-oil',
          quantityInBaseUnit: D('1.0000000000000000001'),
        },
        {
          ingredientId: 'ingredient-untracked',
          ingredientName: 'Untracked garnish',
          baseUnitId: 'unit-gram',
          stockItemId: null,
          quantityInBaseUnit: D('99'),
        },
      ],
    });

    await postOrderRecipeConsumption(
      db,
      'order-1',
      'branch-1',
      [
        {
          id: 'item-waste',
          productId: 'product-meal',
          variantId: null,
          quantity: 2,
          status: 'VOIDED',
          wastageDisposition: 'WASTE',
        },
      ],
      { staffProfileId: 'staff-1', deviceId: 'device-1' },
      now
    );

    expect(mocks.explodeRecipeInDb).toHaveBeenCalledWith(db, {
      organizationId: 'organization-1',
      recipeVersionId: 'version-recipe-product-meal',
      portions: expect.any(Prisma.Decimal),
    });
    expect(
      (mocks.explodeRecipeInDb.mock.calls[0]![1].portions as Prisma.Decimal).equals(D('2'))
    ).toBe(true);
    expect(mocks.postStockMovements).toHaveBeenCalledTimes(1);
    const posting = mocks.postStockMovements.mock.calls[0]![1];
    expect(posting).toMatchObject({
      actor: { staffProfileId: 'staff-1', deviceId: 'device-1' },
      now,
      commandType: 'stock.wastage',
      movements: [
        {
          stockItemId: 'stock-flour',
          locationId: 'location-1',
          reason: 'WASTAGE',
          unitId: 'unit-gram',
          orderId: 'order-1',
        },
        {
          stockItemId: 'stock-oil',
          locationId: 'location-1',
          reason: 'WASTAGE',
          unitId: 'unit-litre',
          orderId: 'order-1',
        },
      ],
    });
    expect(posting.movements[0].quantity.equals(D('-0.2469135780246913578'))).toBe(true);
    expect(posting.movements[1].quantity.equals(D('-1.0000000000000000001'))).toBe(true);
  });

  it.each(['RESTOCK', 'NONE'] as const)('does not post %s voided items', async (disposition) => {
    const db = makeDb();

    await postOrderRecipeConsumption(db, 'order-1', 'branch-1', [
      {
        id: `item-${disposition.toLowerCase()}`,
        productId: 'product-meal',
        variantId: null,
        quantity: 1,
        status: 'VOIDED',
        wastageDisposition: disposition,
      },
    ]);

    expect(mocks.explodeRecipeInDb).not.toHaveBeenCalled();
    expect(mocks.postStockMovements).not.toHaveBeenCalled();
  });

  it('propagates a posting failure so the enclosing order transaction can roll back', async () => {
    const db = makeDb();
    const failure = new Error('movement insert failed');
    mocks.explodeRecipeInDb.mockResolvedValue({
      ingredients: [
        {
          ingredientId: 'ingredient-flour',
          ingredientName: 'Flour',
          baseUnitId: 'unit-gram',
          stockItemId: 'stock-flour',
          quantityInBaseUnit: D('0.5'),
        },
      ],
    });
    mocks.postStockMovements.mockRejectedValue(failure);

    await expect(
      postOrderRecipeConsumption(db, 'order-1', 'branch-1', [
        {
          id: 'item-waste',
          productId: 'product-meal',
          variantId: null,
          quantity: 1,
          status: 'VOIDED',
          wastageDisposition: 'WASTE',
        },
      ])
    ).rejects.toBe(failure);
  });
});
