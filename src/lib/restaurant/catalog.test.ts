import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';
import {
  CatalogError,
  attachModifierGroup,
  attachProductAllergen,
  createBrand,
  createCategory,
  createComboGroup,
  createModifierGroup,
  createModifierOption,
  createProduct,
  createVariant,
  deleteVariant,
  ensureDefaultBrand,
  getBrand,
  getProduct,
  listBrands,
  listCategories,
  listProducts,
  setBrandStatus,
  setDefaultBrand,
  setProductStatus,
  updateCategory,
} from './catalog';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

vi.mock('server-only', () => ({}));

/**
 * These unit tests run the real catalog module against a hand-rolled in-memory
 * db (no PostgreSQL). They exercise this lane's business rules — the C6 default-
 * brand invariant, the brands limit, structural guards, and localization round-
 * trip — not Prisma or RLS, which the router/RLS suites cover.
 */
type Delegate = Record<string, ReturnType<typeof vi.fn>>;

function makeDb() {
  const model = (): Delegate => ({
    findFirst: vi.fn().mockResolvedValue(null),
    findUnique: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'generated_id',
      ...data,
    })),
    update: vi
      .fn()
      .mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: where.id,
          ...data,
        })
      ),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    delete: vi.fn().mockResolvedValue({}),
  });
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([{ organizationId: 'org_1' }]),
    restaurantBrand: model(),
    restaurantCategory: model(),
    restaurantProduct: model(),
    restaurantProductVariant: model(),
    restaurantModifierGroup: model(),
    restaurantModifierOption: model(),
    restaurantProductModifierGroup: model(),
    restaurantComboComponentGroup: model(),
    restaurantComboComponentOption: model(),
    restaurantProductAllergen: model(),
    restaurantAllergen: model(),
    restaurantPriceListEntry: model(),
    restaurantMenuItem: model(),
    // Run the callback against this same mock db so tx delegates are the mocks.
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return db;
}

let db: ReturnType<typeof makeDb>;
beforeEach(() => {
  db = makeDb();
});

const scoped = () => db as unknown as ScopedDb;

describe('ensureDefaultBrand (C6 — idempotent, uncounted baseline)', () => {
  it('returns the existing default without creating a second', async () => {
    db.restaurantBrand.findFirst.mockResolvedValue({ id: 'brand_default', isDefault: true });
    const brand = await ensureDefaultBrand(scoped());
    expect(brand).toMatchObject({ id: 'brand_default' });
    expect(db.restaurantBrand.create).not.toHaveBeenCalled();
  });

  it('lazily creates the default when none exists', async () => {
    const brand = await ensureDefaultBrand(scoped());
    expect(db.restaurantBrand.create).toHaveBeenCalledWith({
      data: { organizationId: 'org_1', name: 'Default Brand', isDefault: true },
    });
    expect(brand).toMatchObject({ isDefault: true });
  });

  it('re-reads and returns the winner when a concurrent create races (P2002)', async () => {
    db.restaurantBrand.findFirst
      .mockResolvedValueOnce(null) // first look: none yet
      .mockResolvedValueOnce({ id: 'brand_race', isDefault: true }); // after the race
    db.restaurantBrand.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    const brand = await ensureDefaultBrand(scoped());
    expect(brand).toMatchObject({ id: 'brand_race' });
  });
});

describe('createBrand (restaurant.brands.max)', () => {
  it('rejects creation once the active-brand limit is reached', async () => {
    db.restaurantBrand.count.mockResolvedValue(3);
    await expect(createBrand(scoped(), { name: 'Second' }, 3)).rejects.toMatchObject({
      reason: 'BRAND_LIMIT_REACHED',
    });
    expect(db.restaurantBrand.create).not.toHaveBeenCalled();
  });

  it('creates an additional (non-default) brand under the limit with localization', async () => {
    db.restaurantBrand.count.mockResolvedValue(1);
    await createBrand(scoped(), { name: '  Virtual  ', nameLocalized: { ar: 'افتراضي' } }, 3);
    expect(db.restaurantBrand.create).toHaveBeenCalledWith({
      data: { organizationId: 'org_1', name: 'Virtual', nameLocalized: { ar: 'افتراضي' } },
    });
  });
});

describe('setDefaultBrand (atomic single-default flip)', () => {
  it('clears the prior default then sets the target in one transaction', async () => {
    db.restaurantBrand.findUnique.mockResolvedValue({
      id: 'brand_2',
      status: 'ACTIVE',
      isDefault: false,
    });
    await setDefaultBrand(scoped(), 'brand_2');
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.restaurantBrand.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', isDefault: true, id: { not: 'brand_2' } },
      data: { isDefault: false },
    });
    expect(db.restaurantBrand.update).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'brand_2' },
      data: { isDefault: true },
    });
  });

  it('refuses to promote an archived brand', async () => {
    db.restaurantBrand.findUnique.mockResolvedValue({
      id: 'brand_x',
      status: 'ARCHIVED',
      isDefault: false,
    });
    await expect(setDefaultBrand(scoped(), 'brand_x')).rejects.toMatchObject({ reason: 'INVALID' });
  });
});

describe('setBrandStatus (default protection)', () => {
  it('refuses to archive the default brand', async () => {
    db.restaurantBrand.findUnique.mockResolvedValue({
      id: 'brand_default',
      status: 'ACTIVE',
      isDefault: true,
    });
    await expect(setBrandStatus(scoped(), 'brand_default', 'ARCHIVED')).rejects.toMatchObject({
      reason: 'DEFAULT_BRAND_PROTECTED',
    });
  });
});

describe('category hierarchy (cycle guard)', () => {
  it('rejects making a category its own parent', async () => {
    db.restaurantCategory.findUnique.mockResolvedValue({ id: 'cat_1' });
    await expect(updateCategory(scoped(), 'cat_1', { parentId: 'cat_1' })).rejects.toMatchObject({
      reason: 'CATEGORY_CYCLE',
    });
  });

  it('rejects reparenting under a descendant (walks the ancestor chain)', async () => {
    // cat_1 exists; proposed parent cat_child -> chains up to cat_1 (a cycle).
    db.restaurantCategory.findUnique.mockImplementation(
      async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        if (select?.parentId) {
          // ancestor-chain lookups
          if (where.id === 'cat_child') return { parentId: 'cat_1' };
          return { parentId: null };
        }
        return { id: where.id }; // existence checks pass
      }
    );
    await expect(
      updateCategory(scoped(), 'cat_1', { parentId: 'cat_child' })
    ).rejects.toMatchObject({ reason: 'CATEGORY_CYCLE' });
  });

  it('creates a subcategory with a valid parent and sort order', async () => {
    db.restaurantCategory.findUnique.mockResolvedValue({ id: 'cat_parent' });
    await createCategory(scoped(), { name: 'Drinks', parentId: 'cat_parent', sortOrder: 2 });
    expect(db.restaurantCategory.create).toHaveBeenCalledWith({
      data: {
        organizationId: 'org_1',
        name: 'Drinks',
        nameLocalized: undefined,
        parentId: 'cat_parent',
        sortOrder: 2,
      },
    });
  });
});

describe('products & variants', () => {
  it('creates a product with localized name and description round-trip', async () => {
    await createProduct(scoped(), {
      name: 'Burger',
      nameLocalized: { ar: 'برجر' },
      description: 'Beef',
      descriptionLocalized: { ar: 'لحم' },
    });
    expect(db.restaurantProduct.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Burger',
        nameLocalized: { ar: 'برجر' },
        description: 'Beef',
        descriptionLocalized: { ar: 'لحم' },
        type: 'ITEM',
      }),
    });
  });

  it('archives a product rather than deleting it', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue({ id: 'prod_1', type: 'ITEM' });
    await setProductStatus(scoped(), 'prod_1', 'ARCHIVED');
    expect(db.restaurantProduct.update).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'prod_1' },
      data: { status: 'ARCHIVED' },
    });
    expect(db.restaurantProduct.delete).not.toHaveBeenCalled?.();
  });

  it('refuses to delete a variant referenced by a price list or menu', async () => {
    db.restaurantProductVariant.findUnique.mockResolvedValue({ id: 'var_1' });
    db.restaurantPriceListEntry.count.mockResolvedValue(1);
    await expect(deleteVariant(scoped(), 'var_1')).rejects.toMatchObject({ reason: 'REFERENCED' });
    expect(db.restaurantProductVariant.delete).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced variant', async () => {
    db.restaurantProductVariant.findUnique.mockResolvedValue({ id: 'var_2' });
    await deleteVariant(scoped(), 'var_2');
    expect(db.restaurantProductVariant.delete).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'var_2' },
    });
  });

  it('creates a variant only for an existing product', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue(null);
    await expect(
      createVariant(scoped(), { productId: 'gone', name: 'Large' })
    ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });
});

describe('modifiers & combos', () => {
  it('rejects incoherent modifier selection bounds', async () => {
    await expect(
      createModifierGroup(scoped(), { name: 'Sauce', minSelect: 2, maxSelect: 1 })
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('creates a modifier option with a Decimal price delta (no float)', async () => {
    db.restaurantModifierGroup.findUnique.mockResolvedValue({ id: 'grp_1' });
    await createModifierOption(scoped(), {
      modifierGroupId: 'grp_1',
      name: 'Extra cheese',
      priceDelta: '1.50',
    });
    const arg = db.restaurantModifierOption.create.mock.calls[0][0].data;
    expect(arg.priceDelta).toBeInstanceOf(Prisma.Decimal);
    expect(arg.priceDelta.toString()).toBe('1.5');
  });

  it('rejects a combo group on a non-COMBO product', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue({ id: 'prod_item', type: 'ITEM' });
    await expect(
      createComboGroup(scoped(), { comboProductId: 'prod_item', name: 'Choose a side' })
    ).rejects.toMatchObject({ reason: 'NOT_A_COMBO' });
  });

  it('rejects attaching an already-attached modifier group', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue({ id: 'prod_1', type: 'ITEM' });
    db.restaurantModifierGroup.findUnique.mockResolvedValue({ id: 'grp_1' });
    db.restaurantProductModifierGroup.findUnique.mockResolvedValue({ id: 'att_existing' });
    await expect(attachModifierGroup(scoped(), 'prod_1', 'grp_1')).rejects.toMatchObject({
      reason: 'ALREADY_ATTACHED',
    });
    expect(db.restaurantProductModifierGroup.create).not.toHaveBeenCalled();
  });
});

describe('product-allergen attachment', () => {
  it('rejects a duplicate allergen declaration', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue({ id: 'prod_1', type: 'ITEM' });
    db.restaurantAllergen.findUnique.mockResolvedValue({ id: 'alg_1' });
    db.restaurantProductAllergen.findUnique.mockResolvedValue({ id: 'link_existing' });
    await expect(attachProductAllergen(scoped(), 'prod_1', 'alg_1')).rejects.toBeInstanceOf(
      CatalogError
    );
    expect(db.restaurantProductAllergen.create).not.toHaveBeenCalled();
  });

  it('attaches a new allergen to a product', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue({ id: 'prod_1', type: 'ITEM' });
    db.restaurantAllergen.findUnique.mockResolvedValue({ id: 'alg_1' });
    await attachProductAllergen(scoped(), 'prod_1', 'alg_1');
    expect(db.restaurantProductAllergen.create).toHaveBeenCalledWith({
      data: { organizationId: 'org_1', productId: 'prod_1', allergenId: 'alg_1' },
    });
  });
});

describe('read models (console read-contract)', () => {
  it('listBrands orders default brand first, then by name', async () => {
    db.restaurantBrand.findMany.mockResolvedValue([{ id: 'b1', isDefault: true, name: 'A' }]);
    const brands = await listBrands(scoped());
    expect(brands).toHaveLength(1);
    expect(db.restaurantBrand.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1' },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
  });

  it('getBrand returns the row or throws NOT_FOUND', async () => {
    db.restaurantBrand.findUnique.mockResolvedValue({ id: 'b1', name: 'A' });
    expect(await getBrand(scoped(), 'b1')).toMatchObject({ id: 'b1' });
    db.restaurantBrand.findUnique.mockResolvedValue(null);
    await expect(getBrand(scoped(), 'missing')).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });

  it('listCategories orders by sortOrder then name', async () => {
    db.restaurantCategory.findMany.mockResolvedValue([]);
    await listCategories(scoped());
    expect(db.restaurantCategory.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  });

  it('listProducts includes category/variants/modifier groups and filters', async () => {
    db.restaurantProduct.findMany.mockResolvedValue([]);
    await listProducts(scoped(), { categoryId: 'cat_1', status: 'ACTIVE' });
    const call = db.restaurantProduct.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      include: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({
      organizationId: 'org_1',
      categoryId: 'cat_1',
      status: 'ACTIVE',
    });
    expect(call.include).toHaveProperty('category');
    expect(call.include).toHaveProperty('variants');
    expect(call.include).toHaveProperty('modifierGroups');
  });

  it('getProduct returns the product with relations or NOT_FOUND', async () => {
    db.restaurantProduct.findUnique.mockResolvedValue({
      id: 'prod_1',
      variants: [],
      modifierGroups: [],
    });
    expect(await getProduct(scoped(), 'prod_1')).toMatchObject({ id: 'prod_1' });
    db.restaurantProduct.findUnique.mockResolvedValue(null);
    await expect(getProduct(scoped(), 'missing')).rejects.toMatchObject({ reason: 'NOT_FOUND' });
  });
});
