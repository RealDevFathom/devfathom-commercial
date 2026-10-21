/** WHA-37 M3 API acceptance: governance, catalog, history, and entitlement gates. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  annotateAudit: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (entitlements: { enabledModules: string[] }, key: string) =>
    entitlements.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.annotateAudit,
  diffChanges: vi.fn(() => ({})),
}));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});

import { Prisma } from '@/generated/prisma/client';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '@/server/trpc';
import { restaurantCatalogRouter } from '@/server/routers/restaurant-catalog';
import { restaurantMenusRouter } from '@/server/routers/restaurant-menus';

const acceptanceRouter = router({
  restaurantCatalog: restaurantCatalogRouter,
  restaurantMenus: restaurantMenusRouter,
});

type Row = { id: string } & Record<string, unknown>;
type IdArgs = { where: { id: string } };
type CreateArgs = { data: Record<string, unknown> };
type UpdateArgs = IdArgs & { data: Record<string, unknown> };

function makeFixture() {
  let nextId = 0;
  const makeRow = (prefix: string, data: Record<string, unknown>): Row => ({
    id: `${prefix}_${++nextId}`,
    ...data,
  });
  const find = (rows: Map<string, Row>, id: string) => rows.get(id) ?? null;
  const update = (rows: Map<string, Row>, { where, data }: UpdateArgs) => {
    const current = rows.get(where.id);
    if (!current) return null;
    const changed = { ...current, ...data };
    rows.set(where.id, changed);
    return { ...changed };
  };

  const brands = new Map<string, Row>();
  const products = new Map<string, Row>();
  const recipes = new Map<string, Row>();
  const recipeVersions = new Map<string, Row>();
  const menus = new Map<string, Row>();
  const sections = new Map<string, Row>();
  const items = new Map<string, Row>();
  const branches = new Map<string, Row>([
    ['branch_1', { id: 'branch_1', name: 'Downtown', timezone: 'UTC' }],
  ]);
  const priceLists = new Map<string, Row>();
  const publications = new Map<string, Row>();
  const overrides = new Map<string, Row>();

  const brandCreate = vi.fn(async ({ data }: CreateArgs) => {
    const brand = makeRow('brand', {
      status: 'ACTIVE',
      isDefault: false,
      nameLocalized: null,
      ...data,
    });
    brands.set(brand.id, brand);
    return { ...brand };
  });

  const productCreate = vi.fn(async ({ data }: CreateArgs) => {
    const product = makeRow('product', {
      type: 'ITEM',
      status: 'ACTIVE',
      nameLocalized: null,
      descriptionLocalized: null,
      ...data,
    });
    products.set(product.id, product);
    return { ...product };
  });

  const recipeCreate = vi.fn(async ({ data }: CreateArgs) => {
    const recipe = makeRow('recipe', data);
    recipes.set(recipe.id, recipe);
    return { ...recipe };
  });

  const recipeVersionCreate = vi.fn(async ({ data }: CreateArgs) => {
    const version = makeRow('recipe_version', data);
    recipeVersions.set(version.id, version);
    return { ...version };
  });

  const menuCreate = vi.fn(async ({ data }: CreateArgs) => {
    const menu = makeRow('menu', data);
    menus.set(menu.id, menu);
    return { ...menu };
  });

  const sectionCreate = vi.fn(async ({ data }: CreateArgs) => {
    const section = makeRow('section', data);
    sections.set(section.id, section);
    return { ...section };
  });

  const itemCreate = vi.fn(async ({ data }: CreateArgs) => {
    const item = makeRow('item', data);
    items.set(item.id, item);
    return { ...item };
  });

  function richPublication(publication: Row) {
    const menu = menus.get(String(publication.menuId));
    const menuSections = [...sections.values()]
      .filter((section) => section.menuId === publication.menuId)
      .map((section) => ({
        ...section,
        items: [...items.values()]
          .filter((item) => item.sectionId === section.id)
          .map((item) => ({
            ...item,
            product: products.get(String(item.productId)),
            variant: null,
          })),
      }));
    return {
      ...publication,
      branch: branches.get(String(publication.branchId)),
      windows: [],
      exceptions: [],
      itemOverrides: [...overrides.values()].filter(
        (override) => override.publicationId === publication.id
      ),
      menu: { ...menu, sections: menuSections },
    };
  }

  const publicationFindUnique = vi.fn(
    async (args: IdArgs & { include?: Record<string, unknown> }) => {
      const publication = find(publications, args.where.id);
      if (!publication) return null;
      return args.include ? richPublication(publication) : { ...publication };
    }
  );

  const db: Record<string, unknown> = {
    $queryRaw: vi.fn(async () => [{ organizationId: 'org_m3' }]),
    restaurantBrand: {
      findFirst: vi.fn(
        async () => [...brands.values()].find((brand) => brand.isDefault === true) ?? null
      ),
      findUnique: vi.fn(async ({ where }: IdArgs) => find(brands, where.id)),
      count: vi.fn(
        async () => [...brands.values()].filter((brand) => brand.status === 'ACTIVE').length
      ),
      create: brandCreate,
      update: vi.fn(async (args: UpdateArgs) => update(brands, args)),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        for (const [id, brand] of brands) {
          if (brand.isDefault === true) brands.set(id, { ...brand, ...data });
        }
        return { count: brands.size };
      }),
    },
    restaurantProduct: {
      findMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] }; organizationId: string } }) =>
          where.id.in.flatMap((id) => {
            const row = products.get(id);
            return row?.organizationId === where.organizationId ? [{ id }] : [];
          })
      ),
      findUnique: vi.fn(async ({ where }: IdArgs) => find(products, where.id)),
      create: productCreate,
      update: vi.fn(async (args: UpdateArgs) => update(products, args)),
    },
    restaurantRecipe: {
      findMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] }; organizationId: string } }) =>
          where.id.in.flatMap((id) => {
            const row = recipes.get(id);
            return row?.organizationId === where.organizationId ? [{ id }] : [];
          })
      ),
      findUnique: vi.fn(async ({ where }: IdArgs) => find(recipes, where.id)),
      create: recipeCreate,
    },
    restaurantRecipeVersion: {
      findUnique: vi.fn(async ({ where }: IdArgs) => find(recipeVersions, where.id)),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { recipeId?: string; organizationId: string; id?: { in: string[] } };
        }) =>
          [...recipeVersions.values()]
            .filter(
              (version) =>
                version.organizationId === where.organizationId &&
                (where.id ? where.id.in.includes(version.id) : version.recipeId === where.recipeId)
            )
            .map((version) => ({ ...version }))
      ),
      create: recipeVersionCreate,
      update: vi.fn(async (args: UpdateArgs) => update(recipeVersions, args)),
    },
    restaurantMenu: {
      findUnique: vi.fn(async ({ where }: IdArgs) => find(menus, where.id)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => (menus.has(id) ? [{ id }] : []))
      ),
      create: menuCreate,
      update: vi.fn(async (args: UpdateArgs) => update(menus, args)),
    },
    restaurantMenuSection: {
      findUnique: vi.fn(async ({ where }: IdArgs) => find(sections, where.id)),
      create: sectionCreate,
      update: vi.fn(async (args: UpdateArgs) => update(sections, args)),
    },
    restaurantMenuItem: {
      findUnique: vi.fn(async ({ where }: IdArgs) => {
        const item = find(items, where.id);
        if (!item) return null;
        const section = sections.get(String(item.sectionId));
        return { ...item, section: { menuId: section?.menuId } };
      }),
      create: itemCreate,
      update: vi.fn(async (args: UpdateArgs) => update(items, args)),
    },
    restaurantProductVariant: {
      findUnique: vi.fn(async () => null),
    },
    restaurantBranch: {
      findUnique: vi.fn(async ({ where }: IdArgs) => find(branches, where.id)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => (branches.has(id) ? [{ id }] : []))
      ),
    },
    restaurantPriceList: {
      findUnique: vi.fn(async ({ where }: IdArgs) => find(priceLists, where.id)),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => (priceLists.has(id) ? [{ id }] : []))
      ),
    },
    restaurantPriceListVersion: {
      findMany: vi.fn(async () => []),
    },
    restaurantPriceListEntry: {
      findMany: vi.fn(async () => []),
    },
    restaurantBranchMenuPublication: {
      findUnique: publicationFindUnique,
      create: vi.fn(async ({ data }: CreateArgs) => {
        const publication = makeRow('publication', {
          publishedAt: null,
          retiredAt: null,
          ...data,
        });
        publications.set(publication.id, publication);
        return { ...publication };
      }),
      update: vi.fn(async (args: UpdateArgs) => update(publications, args)),
    },
    restaurantBranchMenuItemOverride: {
      findUnique: vi.fn(async ({ where }: IdArgs) => find(overrides, where.id)),
      upsert: vi.fn(
        async ({
          create,
          update: patch,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = [...overrides.values()].find(
            (override) =>
              override.publicationId === create.publicationId &&
              override.menuItemId === create.menuItemId
          );
          if (existing) return update(overrides, { where: { id: existing.id }, data: patch });
          const override = makeRow('override', {
            ...create,
            priceOverride:
              create.priceOverride == null
                ? null
                : new Prisma.Decimal(String(create.priceOverride)),
          });
          overrides.set(override.id, override);
          return { ...override };
        }
      ),
      delete: vi.fn(async ({ where }: IdArgs) => {
        overrides.delete(where.id);
        return { id: where.id };
      }),
    },
  };
  db.$transaction = vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
    operation(db)
  );

  return {
    db: db as unknown as ScopedDb,
    brands,
    branches,
    menus,
    priceLists,
    publications,
    spies: { brandCreate, publicationFindUnique },
  };
}

type Fixture = ReturnType<typeof makeFixture>;

function api(fixture: Fixture, enabledModules: string[] = ['restaurant-menu'], brandsMax = 5) {
  return acceptanceRouter.createCaller({
    db: fixture.db,
    entitlements: {
      organizationId: 'org_m3',
      enabledModules,
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: { 'restaurant.brands.max': brandsMax },
    },
    session: {
      expires: 'later',
      user: {
        organizationId: 'org_m3',
        id: 'user_gm',
        role: 'EMPLOYEE',
        department: 'OPERATIONS',
        status: 'ACTIVE',
      },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

async function seedMenu(fixture: Fixture) {
  const caller = api(fixture);
  const brand = await caller.restaurantCatalog.ensureDefaultBrand({ name: 'Main Brand' });
  const product = await caller.restaurantCatalog.createProduct({ name: 'Burger' });
  const menu = await caller.restaurantMenus.createMenu({ brandId: brand.id, name: 'Dinner' });
  const section = await caller.restaurantMenus.createSection({ menuId: menu.id, name: 'Mains' });
  const item = await caller.restaurantMenus.createItem({
    sectionId: section.id,
    productId: product.id,
  });
  return { brand, product, menu, section, item };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
});

describe('GOV-1 canonical ownership', () => {
  it('exposes no canonical clone/copy procedure', () => {
    expect(
      Object.keys(restaurantCatalogRouter._def.procedures).filter((name) =>
        /clone|copy/i.test(name)
      )
    ).toEqual([]);
  });

  it('denies canonical creation to a branch actor without menu:write', async () => {
    const fixture = makeFixture();
    const branchCapabilities = new Set(['menu:publish', 'menu:price']);
    mocks.can.mockImplementation(async (_subject, action) =>
      branchCapabilities.has(String(action))
    );

    await expect(
      api(fixture).restaurantCatalog.createBrand({ name: 'Branch Brand' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'menu:write',
      undefined,
      expect.anything()
    );
    expect(fixture.spies.brandCreate).not.toHaveBeenCalled();
  });

  it('rejects branch-scoped fields on canonical brand creation', async () => {
    const fixture = makeFixture();
    const input = { name: 'Branch Shadow', branchId: 'branch_1', shadowCopyOfId: 'brand_root' };

    await expect(api(fixture).restaurantCatalog.createBrand(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(fixture.spies.brandCreate).not.toHaveBeenCalled();
  });

  it('rejects shadow-copy fields on canonical product creation', async () => {
    const fixture = makeFixture();
    const input = { name: 'Shadow Burger', sourceCanonicalId: 'product_root' };

    await expect(api(fixture).restaurantCatalog.createProduct(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('rejects other-organization publication references', async () => {
    const fixture = makeFixture();
    const { menu } = await seedMenu(fixture);
    const caller = api(fixture);

    await expect(
      caller.restaurantMenus.createPublication({ branchId: 'foreign_branch', menuId: menu.id })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.restaurantMenus.createPublication({ branchId: 'branch_1', menuId: 'foreign_menu' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.restaurantMenus.createPublication({
        branchId: 'branch_1',
        menuId: menu.id,
        priceListId: 'foreign_price_list',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects other-organization override references', async () => {
    const fixture = makeFixture();
    const { menu } = await seedMenu(fixture);
    const caller = api(fixture);
    const publication = await caller.restaurantMenus.createPublication({
      branchId: 'branch_1',
      menuId: menu.id,
    });

    await expect(
      caller.restaurantMenus.setItemOverride({
        publicationId: 'foreign_publication',
        menuItemId: 'foreign_item',
        isAvailable: false,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller.restaurantMenus.setItemOverride({
        publicationId: publication.id,
        menuItemId: 'foreign_item',
        isAvailable: false,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('rejects canonical content fields on branch overrides', async () => {
    const fixture = makeFixture();
    const { menu, item } = await seedMenu(fixture);
    const caller = api(fixture);
    const publication = await caller.restaurantMenus.createPublication({
      branchId: 'branch_1',
      menuId: menu.id,
    });
    const input = {
      publicationId: publication.id,
      menuItemId: item.id,
      name: 'Branch-only rename',
      composition: [{ productId: 'shadow_component' }],
    };

    await expect(caller.restaurantMenus.setItemOverride(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('GOV-2 history', () => {
  it('exposes a public historical recipe-version read', () => {
    expect(Object.keys(restaurantCatalogRouter._def.procedures)).toContain('getRecipeVersion');
  });

  it('supersedes recipe v1 without making it mutable while v2 becomes active', async () => {
    const fixture = makeFixture();
    const caller = api(fixture);
    const product = await caller.restaurantCatalog.createProduct({ name: 'Soup' });
    const recipe = await caller.restaurantCatalog.createRecipe({
      productId: product.id,
      name: 'Soup recipe',
    });
    const draftV1 = await caller.restaurantCatalog.createRecipeVersion({
      recipeId: recipe.id,
      yieldQuantity: '2',
      notes: 'original',
    });
    const activeV1 = await caller.restaurantCatalog.activateRecipeVersion({
      recipeId: recipe.id,
      versionId: draftV1.id,
    });
    expect(
      await caller.restaurantCatalog.getActiveRecipeVersion({ recipeId: recipe.id })
    ).toMatchObject({
      id: activeV1.id,
      status: 'ACTIVE',
      notes: 'original',
    });

    const draftV2 = await caller.restaurantCatalog.createRecipeVersion({
      recipeId: recipe.id,
      yieldQuantity: '3',
      notes: 'revised',
    });
    const activeV2 = await caller.restaurantCatalog.activateRecipeVersion({
      recipeId: recipe.id,
      versionId: draftV2.id,
    });

    expect(
      await caller.restaurantCatalog.getActiveRecipeVersion({ recipeId: recipe.id })
    ).toMatchObject({
      id: activeV2.id,
      status: 'ACTIVE',
      notes: 'revised',
    });
    expect(activeV1).toMatchObject({ notes: 'original' });
    await expect(
      caller.restaurantCatalog.updateRecipeVersion({ id: activeV1.id, notes: 'mutated' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('SUPERSEDED'),
    });
  });

  it('keeps a retired publication readable through effectiveMenu', async () => {
    const fixture = makeFixture();
    const { menu } = await seedMenu(fixture);
    const caller = api(fixture);
    const draft = await caller.restaurantMenus.createPublication({
      branchId: 'branch_1',
      menuId: menu.id,
      channels: ['DINE_IN'],
    });
    await caller.restaurantMenus.publishPublication({ id: draft.id });
    await caller.restaurantMenus.retirePublication({ id: draft.id });

    const history = await caller.restaurantMenus.effectiveMenu({
      publicationId: draft.id,
      channel: 'DINE_IN',
      at: new Date('2026-01-01T00:00:00Z'),
    });
    expect(history.publication.status).toBe('RETIRED');
    expect(history.menu).toMatchObject({ id: menu.id, name: 'Dinner' });
  });
});

describe('brand, localization, and module contracts', () => {
  it('creates one default brand and enforces restaurant.brands.max', async () => {
    const fixture = makeFixture();
    const caller = api(fixture, ['restaurant-menu'], 1);
    const first = await caller.restaurantCatalog.ensureDefaultBrand({ name: 'Primary' });
    const second = await caller.restaurantCatalog.ensureDefaultBrand({ name: 'Ignored' });

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ isDefault: true, status: 'ACTIVE' });
    expect(fixture.spies.brandCreate).toHaveBeenCalledTimes(1);
    await expect(caller.restaurantCatalog.createBrand({ name: 'Too Many' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('round-trips menu, section, and item localization fields', async () => {
    const fixture = makeFixture();
    const caller = api(fixture);
    const brand = await caller.restaurantCatalog.ensureDefaultBrand();
    const product = await caller.restaurantCatalog.createProduct({ name: 'Tea' });
    const localized = { 'ar-SA': 'قائمة', 'ur-PK': 'مینو' };
    const menu = await caller.restaurantMenus.createMenu({
      brandId: brand.id,
      name: 'Menu',
      nameLocalized: localized,
    });
    const section = await caller.restaurantMenus.createSection({
      menuId: menu.id,
      name: 'Drinks',
      nameLocalized: localized,
    });
    const item = await caller.restaurantMenus.createItem({
      sectionId: section.id,
      productId: product.id,
      nameLocalized: localized,
    });

    expect(menu.nameLocalized).toEqual(localized);
    expect(section.nameLocalized).toEqual(localized);
    expect(item.nameLocalized).toEqual(localized);
  });

  it('round-trips product catalog localization fields', async () => {
    const fixture = makeFixture();
    const localized = { 'ar-SA': 'شاي', 'ur-PK': 'چائے' };
    const descriptionLocalized = { 'ar-SA': 'شاي ساخن', 'ur-PK': 'گرم چائے' };
    const input = {
      name: 'Tea',
      nameLocalized: localized,
      description: 'Hot tea',
      descriptionLocalized,
    };

    const product = await api(fixture).restaurantCatalog.createProduct(input);

    expect(product).toMatchObject({ nameLocalized: localized, descriptionLocalized });
  });

  it('denies both public router surfaces without restaurant-menu entitlement', async () => {
    const fixture = makeFixture();
    const caller = api(fixture, []);

    await expect(caller.restaurantCatalog.ensureDefaultBrand()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('restaurant-menu'),
    });
    await expect(
      caller.restaurantMenus.effectiveMenu({
        publicationId: 'publication_1',
        channel: 'DINE_IN',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fixture.spies.brandCreate).not.toHaveBeenCalled();
    expect(fixture.spies.publicationFindUnique).not.toHaveBeenCalled();
  });
});
