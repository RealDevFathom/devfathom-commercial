/** WHA-37 M3 API acceptance: publication availability and pricing. */
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
import { restaurantMenusRouter } from '@/server/routers/restaurant-menus';

const apiRouter = router({ restaurantMenus: restaurantMenusRouter });
const decimal = (value: string) => new Prisma.Decimal(value);

type PriceListRow = { id: string; name: string; isDefault: boolean };
type VersionRow = {
  id: string;
  priceListId: string;
  versionNumber: number;
  effectiveFrom: Date;
  status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED';
  activatedAt?: Date;
  supersededAt?: Date;
};
type EntryRow = {
  id: string;
  priceListVersionId: string;
  productId: string;
  variantId: string | null;
  price: Prisma.Decimal;
};
type PublicationRow = {
  id: string;
  branchId: string;
  menuId: string;
  priceListId: string | null;
  channels: string[];
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  publishedAt: Date | null;
  retiredAt: Date | null;
};
type WindowRow = {
  id: string;
  publicationId: string;
  menuItemId: string | null;
  label: string | null;
  daysOfWeek: number[];
  startMinutes: number;
  endMinutes: number;
};
type ExceptionRow = {
  id: string;
  publicationId: string;
  date: Date;
  isClosed: boolean;
  label: string | null;
};
type OverrideRow = {
  id: string;
  publicationId: string;
  menuItemId: string;
  isAvailable: boolean;
  priceOverride: Prisma.Decimal | null;
};
type IdArgs = { where: { id: string } };
type DataArgs = { data: Record<string, unknown> };

function makeFixture() {
  let nextId = 0;
  const id = (prefix: string) => `${prefix}_${++nextId}`;
  const priceLists = new Map<string, PriceListRow>();
  const versions = new Map<string, VersionRow>();
  const entries = new Map<string, EntryRow>();
  const publications = new Map<string, PublicationRow>();
  const windows = new Map<string, WindowRow>();
  const exceptions = new Map<string, ExceptionRow>();
  const overrides = new Map<string, OverrideRow>();
  const products = new Map([
    [
      'product_pub',
      {
        id: 'product_pub',
        name: 'Published item',
        type: 'ITEM',
        status: 'ACTIVE',
        nameLocalized: null,
        descriptionLocalized: null,
      },
    ],
    [
      'product_base',
      {
        id: 'product_base',
        name: 'Base item',
        type: 'ITEM',
        status: 'ACTIVE',
        nameLocalized: null,
        descriptionLocalized: null,
      },
    ],
  ]);
  const menuItems = new Map([
    [
      'item_pub',
      {
        id: 'item_pub',
        sectionId: 'section_1',
        productId: 'product_pub',
        variantId: null,
        displayName: null,
        nameLocalized: null,
        sortOrder: 0,
      },
    ],
    [
      'item_base',
      {
        id: 'item_base',
        sectionId: 'section_1',
        productId: 'product_base',
        variantId: null,
        displayName: null,
        nameLocalized: null,
        sortOrder: 1,
      },
    ],
  ]);
  const branch = { id: 'branch_1', name: 'Downtown', timezone: 'America/New_York' };
  const menu = {
    id: 'menu_1',
    brandId: 'brand_1',
    name: 'Dinner',
    nameLocalized: { 'ur-PK': 'رات کا کھانا' },
    description: null,
  };

  function richPublication(publication: PublicationRow) {
    return {
      ...publication,
      branch,
      windows: [...windows.values()].filter((window) => window.publicationId === publication.id),
      exceptions: [...exceptions.values()].filter(
        (exception) => exception.publicationId === publication.id
      ),
      itemOverrides: [...overrides.values()].filter(
        (override) => override.publicationId === publication.id
      ),
      menu: {
        ...menu,
        sections: [
          {
            id: 'section_1',
            name: 'Mains',
            nameLocalized: null,
            sortOrder: 0,
            items: [...menuItems.values()].map((item) => ({
              ...item,
              product: products.get(item.productId),
              variant: null,
            })),
          },
        ],
      },
    };
  }

  const db: Record<string, unknown> = {
    restaurantBranch: {
      findUnique: vi.fn(async ({ where }: IdArgs) => (where.id === branch.id ? branch : null)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => id === branch.id).map((id) => ({ id }))
      ),
    },
    restaurantMenu: {
      findUnique: vi.fn(async ({ where }: IdArgs) => (where.id === menu.id ? menu : null)),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.filter((id) => id === menu.id).map((id) => ({ id }))
      ),
    },
    restaurantMenuItem: {
      findUnique: vi.fn(async ({ where }: IdArgs) =>
        menuItems.has(where.id) ? { id: where.id, section: { menuId: menu.id } } : null
      ),
    },
    restaurantProduct: {
      findUnique: vi.fn(async ({ where }: IdArgs) => products.get(where.id) ?? null),
    },
    restaurantProductVariant: {
      findUnique: vi.fn(async () => null),
    },
    restaurantPriceList: {
      findUnique: vi.fn(async ({ where }: IdArgs) => priceLists.get(where.id) ?? null),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.flatMap((id) => (priceLists.has(id) ? [{ id }] : []))
      ),
      findFirst: vi.fn(
        async () => [...priceLists.values()].find((priceList) => priceList.isDefault) ?? null
      ),
      create: vi.fn(async ({ data }: DataArgs) => {
        const priceList: PriceListRow = {
          id: id('price_list'),
          name: String(data.name),
          isDefault: data.isDefault === true,
        };
        priceLists.set(priceList.id, priceList);
        return { ...priceList };
      }),
      updateMany: vi.fn(async ({ data }: DataArgs) => {
        let count = 0;
        for (const [priceListId, priceList] of priceLists) {
          if (!priceList.isDefault) continue;
          priceLists.set(priceListId, { ...priceList, isDefault: data.isDefault === true });
          count += 1;
        }
        return { count };
      }),
    },
    restaurantPriceListVersion: {
      findUnique: vi.fn(async ({ where }: IdArgs) => versions.get(where.id) ?? null),
      findMany: vi.fn(
        async ({ where }: { where: { priceListId: string; status?: { not: string } } }) =>
          [...versions.values()].filter(
            (version) =>
              version.priceListId === where.priceListId &&
              (!where.status || version.status !== where.status.not)
          )
      ),
      create: vi.fn(async ({ data }: DataArgs) => {
        const version: VersionRow = {
          id: id('price_version'),
          priceListId: String(data.priceListId),
          versionNumber: Number(data.versionNumber),
          effectiveFrom: data.effectiveFrom as Date,
          status: 'DRAFT',
        };
        versions.set(version.id, version);
        return { ...version };
      }),
      update: vi.fn(async ({ where, data }: IdArgs & DataArgs) => {
        const current = versions.get(where.id);
        if (!current) return null;
        const changed = { ...current, ...data } as VersionRow;
        versions.set(where.id, changed);
        return { ...changed };
      }),
    },
    restaurantPriceListEntry: {
      findUnique: vi.fn(async ({ where }: IdArgs) => entries.get(where.id) ?? null),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { priceListVersionId: string; productId: string; variantId: string | null };
        }) =>
          [...entries.values()].find(
            (entry) =>
              entry.priceListVersionId === where.priceListVersionId &&
              entry.productId === where.productId &&
              entry.variantId === where.variantId
          ) ?? null
      ),
      findMany: vi.fn(async ({ where }: { where: { priceListVersionId: string } }) =>
        [...entries.values()].filter(
          (entry) => entry.priceListVersionId === where.priceListVersionId
        )
      ),
      create: vi.fn(async ({ data }: DataArgs) => {
        const entry: EntryRow = {
          id: id('price_entry'),
          priceListVersionId: String(data.priceListVersionId),
          productId: String(data.productId),
          variantId: data.variantId == null ? null : String(data.variantId),
          price: data.price instanceof Prisma.Decimal ? data.price : decimal(String(data.price)),
        };
        entries.set(entry.id, entry);
        return { ...entry };
      }),
    },
    restaurantBranchMenuPublication: {
      findUnique: vi.fn(async (args: IdArgs & { include?: Record<string, unknown> }) => {
        const publication = publications.get(args.where.id);
        if (!publication) return null;
        return args.include ? richPublication(publication) : { ...publication };
      }),
      create: vi.fn(async ({ data }: DataArgs) => {
        const publication: PublicationRow = {
          id: id('publication'),
          branchId: String(data.branchId),
          menuId: String(data.menuId),
          priceListId: data.priceListId == null ? null : String(data.priceListId),
          channels: (data.channels as string[]) ?? [],
          status: 'DRAFT',
          publishedAt: null,
          retiredAt: null,
        };
        publications.set(publication.id, publication);
        return { ...publication };
      }),
      update: vi.fn(async ({ where, data }: IdArgs & DataArgs) => {
        const current = publications.get(where.id);
        if (!current) return null;
        const changed = { ...current, ...data } as PublicationRow;
        publications.set(where.id, changed);
        return { ...changed };
      }),
    },
    restaurantMenuAvailabilityWindow: {
      create: vi.fn(async ({ data }: DataArgs) => {
        const window: WindowRow = {
          id: id('window'),
          publicationId: String(data.publicationId),
          menuItemId: data.menuItemId == null ? null : String(data.menuItemId),
          label: data.label == null ? null : String(data.label),
          daysOfWeek: data.daysOfWeek as number[],
          startMinutes: Number(data.startMinutes),
          endMinutes: Number(data.endMinutes),
        };
        windows.set(window.id, window);
        return { ...window };
      }),
    },
    restaurantMenuAvailabilityException: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = [...exceptions.values()].find(
            (exception) =>
              exception.publicationId === create.publicationId &&
              exception.date.getTime() === (create.date as Date).getTime()
          );
          if (existing) {
            const changed = { ...existing, ...update } as ExceptionRow;
            exceptions.set(existing.id, changed);
            return { ...changed };
          }
          const exception: ExceptionRow = {
            id: id('exception'),
            publicationId: String(create.publicationId),
            date: create.date as Date,
            isClosed: create.isClosed === true,
            label: create.label == null ? null : String(create.label),
          };
          exceptions.set(exception.id, exception);
          return { ...exception };
        }
      ),
    },
    restaurantBranchMenuItemOverride: {
      findUnique: vi.fn(async ({ where }: IdArgs) => overrides.get(where.id) ?? null),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const existing = [...overrides.values()].find(
            (override) =>
              override.publicationId === create.publicationId &&
              override.menuItemId === create.menuItemId
          );
          const values = existing ? { ...existing, ...update } : create;
          const override: OverrideRow = {
            id: existing?.id ?? id('override'),
            publicationId: String(values.publicationId ?? existing?.publicationId),
            menuItemId: String(values.menuItemId ?? existing?.menuItemId),
            isAvailable: values.isAvailable !== false,
            priceOverride:
              values.priceOverride == null ? null : decimal(String(values.priceOverride)),
          };
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

  return { db: db as unknown as ScopedDb };
}

type Fixture = ReturnType<typeof makeFixture>;

function caller(fixture: Fixture) {
  return apiRouter.createCaller({
    db: fixture.db,
    entitlements: {
      organizationId: 'org_m3',
      enabledModules: ['restaurant-menu'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
      limits: {},
    },
    session: {
      expires: 'later',
      user: { id: 'user_gm', role: 'EMPLOYEE', department: 'OPERATIONS', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

async function publish(
  fixture: Fixture,
  options: { channels?: Array<'DINE_IN' | 'TAKEAWAY'>; priceListId?: string } = {}
) {
  const api = caller(fixture).restaurantMenus;
  const draft = await api.createPublication({
    branchId: 'branch_1',
    menuId: 'menu_1',
    channels: options.channels,
    priceListId: options.priceListId,
  });
  return api.publishPublication({ id: draft.id });
}

async function pricedVersion(
  fixture: Fixture,
  priceListId: string,
  effectiveFrom: string,
  prices: Record<string, string>
) {
  const api = caller(fixture).restaurantMenus;
  const version = await api.createPriceListVersion({
    priceListId,
    effectiveFrom: new Date(effectiveFrom),
  });
  for (const [productId, price] of Object.entries(prices)) {
    await api.addPriceEntry({ priceListVersionId: version.id, productId, price });
  }
  return api.activatePriceListVersion({ versionId: version.id });
}

async function itemAt(
  fixture: Fixture,
  publicationId: string,
  itemId: string,
  at: string,
  channel: 'DINE_IN' | 'TAKEAWAY' = 'DINE_IN'
) {
  const result = await caller(fixture).restaurantMenus.effectiveMenu({
    publicationId,
    channel,
    at: new Date(at),
  });
  return result.sections.flatMap((section) => section.items).find((item) => item.id === itemId);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
});

describe('branch-timezone availability', () => {
  it('evaluates spring-forward gap and both fall-back wall-clock repeats', async () => {
    const fixture = makeFixture();
    const publication = await publish(fixture, { channels: ['DINE_IN'] });
    await caller(fixture).restaurantMenus.addAvailabilityWindow({
      publicationId: publication.id,
      daysOfWeek: [0],
      startMinutes: 60,
      endMinutes: 210,
    });

    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-03-08T06:30:00Z'))?.available
    ).toBe(true);
    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-03-08T07:15:00Z'))?.available
    ).toBe(true);
    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-03-08T07:30:00Z'))?.available
    ).toBe(false);
    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-11-01T05:30:00Z'))?.available
    ).toBe(true);
    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-11-01T06:30:00Z'))?.available
    ).toBe(true);
  });

  it('honors cross-midnight tails and exclusive end boundary', async () => {
    const fixture = makeFixture();
    const publication = await publish(fixture);
    await caller(fixture).restaurantMenus.addAvailabilityWindow({
      publicationId: publication.id,
      daysOfWeek: [5],
      startMinutes: 1320,
      endMinutes: 120,
    });

    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-01-17T06:30:00Z'))?.available
    ).toBe(true);
    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-01-17T07:00:00Z'))?.available
    ).toBe(false);
  });

  it('closes the branch-local exception date', async () => {
    const fixture = makeFixture();
    const publication = await publish(fixture);
    await caller(fixture).restaurantMenus.setAvailabilityException({
      publicationId: publication.id,
      date: new Date('2026-12-25T00:00:00Z'),
      isClosed: true,
    });

    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-12-25T12:00:00Z'))?.available
    ).toBe(false);
    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-12-26T12:00:00Z'))?.available
    ).toBe(true);
  });

  it('combines channel, publication daypart, and item window filters', async () => {
    const fixture = makeFixture();
    const publication = await publish(fixture, { channels: ['DINE_IN'] });
    const api = caller(fixture).restaurantMenus;
    await api.addAvailabilityWindow({
      publicationId: publication.id,
      daysOfWeek: [],
      startMinutes: 600,
      endMinutes: 900,
    });
    await api.addAvailabilityWindow({
      publicationId: publication.id,
      menuItemId: 'item_pub',
      daysOfWeek: [],
      startMinutes: 660,
      endMinutes: 720,
    });

    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-01-15T15:30:00Z'))?.available
    ).toBe(false);
    expect(
      (await itemAt(fixture, publication.id, 'item_base', '2026-01-15T15:30:00Z'))?.available
    ).toBe(true);
    expect(
      (await itemAt(fixture, publication.id, 'item_pub', '2026-01-15T16:30:00Z'))?.available
    ).toBe(true);
  });
});

describe('effective pricing', () => {
  it('resolves past and new price-list versions at the exact boundary instant', async () => {
    const fixture = makeFixture();
    const api = caller(fixture).restaurantMenus;
    const priceList = await api.createPriceList({ name: 'Publication' });
    const v1 = await pricedVersion(fixture, priceList.id, '2026-01-01T00:00:00Z', {
      product_pub: '10.00',
    });
    await pricedVersion(fixture, priceList.id, '2026-02-01T00:00:00Z', {
      product_pub: '20.00',
    });
    await api.supersedePriceListVersion({ versionId: v1.id });
    const publication = await publish(fixture, { priceListId: priceList.id });

    expect(
      await itemAt(fixture, publication.id, 'item_pub', '2026-01-31T23:59:59.999Z')
    ).toMatchObject({ price: '10', priceSource: 'PUBLICATION_LIST' });
    expect(
      await itemAt(fixture, publication.id, 'item_pub', '2026-02-01T00:00:00.000Z')
    ).toMatchObject({ price: '20', priceSource: 'PUBLICATION_LIST' });
  });

  it('uses override over publication list over base, then restores inherited price', async () => {
    const fixture = makeFixture();
    const api = caller(fixture).restaurantMenus;
    const base = await api.createPriceList({ name: 'Base', isDefault: true });
    await pricedVersion(fixture, base.id, '2026-01-01T00:00:00Z', {
      product_pub: '5.00',
      product_base: '7.00',
    });
    const publicationList = await api.createPriceList({ name: 'Publication' });
    await pricedVersion(fixture, publicationList.id, '2026-01-01T00:00:00Z', {
      product_pub: '20.00',
    });
    const publication = await publish(fixture, { priceListId: publicationList.id });
    const override = await api.setItemOverride({
      publicationId: publication.id,
      menuItemId: 'item_pub',
      priceOverride: '30.00',
    });

    expect(await itemAt(fixture, publication.id, 'item_pub', '2026-03-01T00:00:00Z')).toMatchObject(
      {
        price: '30',
        priceSource: 'OVERRIDE',
      }
    );
    expect(
      await itemAt(fixture, publication.id, 'item_base', '2026-03-01T00:00:00Z')
    ).toMatchObject({
      price: '7',
      priceSource: 'BASE_LIST',
    });

    await api.clearItemOverride({ overrideId: override.id });
    expect(await itemAt(fixture, publication.id, 'item_pub', '2026-03-01T00:00:00Z')).toMatchObject(
      {
        price: '20',
        priceSource: 'PUBLICATION_LIST',
      }
    );
  });
});
