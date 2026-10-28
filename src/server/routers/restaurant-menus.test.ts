/**
 * M3-L3 router — capability gating/wiring, publication lifecycle, per-publication
 * price overrides, cross-org reference validation, and the effective-menu read
 * model (winning-price precedence + branch-timezone availability). Runs the REAL
 * router and the REAL L3 libs (menus / price-lists / menu-availability) against a
 * hand-rolled in-memory db; the ABAC decision, entitlement check and audit writer
 * are mocked so the test exercises this lane's logic, not platform middleware.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Prisma } from '@/generated/prisma/client';

const D = (v: string) => new Prisma.Decimal(v);

const mocks = vi.hoisted(() => ({
  // Typed so tests can assert the action passed to `can(subject, action, …)`.
  can: vi.fn<(subject: unknown, action: unknown) => Promise<boolean>>(() => Promise.resolve(true)),
  annotateAudit: vi.fn(),
  branchFindUnique: vi.fn(),
  branchFindMany: vi.fn(),
  menuFindMany: vi.fn(),
  menuFindUnique: vi.fn(),
  itemFindUnique: vi.fn(),
  priceListFindMany: vi.fn(),
  priceListFindFirst: vi.fn(),
  priceListFindUnique: vi.fn(),
  versionFindMany: vi.fn(),
  entryFindMany: vi.fn(),
  pubFindMany: vi.fn(),
  pubFindUnique: vi.fn(),
  pubCreate: vi.fn(),
  pubUpdate: vi.fn(),
  windowCreate: vi.fn(),
  windowFindMany: vi.fn(),
  exceptionFindMany: vi.fn(),
  overrideFindMany: vi.fn(),
  overrideUpsert: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
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

import { restaurantMenusRouter } from './restaurant-menus';
import type { TRPCContext } from '../trpc';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

const db = {
  restaurantBranch: { findUnique: mocks.branchFindUnique, findMany: mocks.branchFindMany },
  restaurantMenu: { findMany: mocks.menuFindMany, findUnique: mocks.menuFindUnique },
  restaurantMenuItem: { findUnique: mocks.itemFindUnique },
  restaurantPriceList: {
    findMany: mocks.priceListFindMany,
    findFirst: mocks.priceListFindFirst,
    findUnique: mocks.priceListFindUnique,
  },
  restaurantPriceListVersion: { findMany: mocks.versionFindMany },
  restaurantPriceListEntry: { findMany: mocks.entryFindMany },
  restaurantBranchMenuPublication: {
    findMany: mocks.pubFindMany,
    findUnique: mocks.pubFindUnique,
    create: mocks.pubCreate,
    update: mocks.pubUpdate,
  },
  restaurantMenuAvailabilityWindow: { findMany: mocks.windowFindMany, create: mocks.windowCreate },
  restaurantMenuAvailabilityException: { findMany: mocks.exceptionFindMany },
  restaurantBranchMenuItemOverride: {
    findMany: mocks.overrideFindMany,
    upsert: mocks.overrideUpsert,
  },
} as unknown as ScopedDb;

function caller() {
  return restaurantMenusRouter.createCaller({
    db,
    entitlements: {
      organizationId: 'org_1',
      enabledModules: ['restaurant-menu'],
      activeSeats: 1,
      seatLimit: 50,
      modules: [],
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.branchFindUnique.mockResolvedValue({ id: 'branch_1' });
  mocks.branchFindMany.mockImplementation(
    async ({ where }: { where?: { id?: { in?: string[] } } } = {}) =>
      (where?.id?.in ?? []).map((id) => ({ id }))
  );
  mocks.menuFindMany.mockImplementation(async (args?: { where?: { id?: { in?: string[] } } }) =>
    args?.where?.id?.in ? args.where.id.in.map((id) => ({ id })) : []
  );
  mocks.menuFindUnique.mockResolvedValue({ id: 'menu_1' });
  mocks.itemFindUnique.mockResolvedValue({ id: 'item_1', section: { menuId: 'menu_1' } });
  mocks.priceListFindMany.mockImplementation(
    async (args?: { where?: { id?: { in?: string[] } } }) =>
      args?.where?.id?.in ? args.where.id.in.map((id) => ({ id })) : []
  );
  mocks.priceListFindFirst.mockResolvedValue(null);
  mocks.priceListFindUnique.mockResolvedValue({ id: 'pl_1' });
  mocks.pubFindMany.mockResolvedValue([]);
  mocks.pubFindUnique.mockResolvedValue({
    id: 'pub_1',
    status: 'DRAFT',
    branchId: 'branch_1',
    menuId: 'menu_1',
    channels: ['DINE_IN'],
  });
  mocks.windowFindMany.mockResolvedValue([]);
  mocks.exceptionFindMany.mockResolvedValue([]);
  mocks.overrideFindMany.mockResolvedValue([]);
  mocks.pubCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'pub_new',
    ...data,
  }));
  mocks.pubUpdate.mockImplementation(
    async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
      id: where.id,
      branchId: 'branch_1',
      menuId: 'menu_1',
      ...data,
    })
  );
  mocks.overrideUpsert.mockImplementation(
    async ({ create }: { create: Record<string, unknown> }) => ({
      id: 'ovr_new',
      ...create,
    })
  );
});

describe('capability gating & wiring (C7)', () => {
  it('denies every capability-gated procedure when ABAC denies', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(
      caller().createPublication({ branchId: 'branch_1', menuId: 'menu_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.pubCreate).not.toHaveBeenCalled();
  });

  it('gates the publication lifecycle on menu:publish', async () => {
    await caller().publishPublication({ id: 'pub_1' });
    expect(mocks.can.mock.calls[0][1]).toBe('menu:publish');
  });

  it('gates item overrides on menu:price', async () => {
    await caller().setItemOverride({
      publicationId: 'pub_1',
      menuItemId: 'item_1',
      priceOverride: '2.50',
    });
    expect(mocks.can.mock.calls[0][1]).toBe('menu:price');
  });
});

describe('console read models (menu:read)', () => {
  it('lists menus, price lists, and publications through menu:read', async () => {
    await caller().listMenus();
    await caller().listPriceLists();
    await caller().listPublications();

    expect(mocks.menuFindMany).toHaveBeenCalledOnce();
    expect(mocks.priceListFindMany).toHaveBeenCalledOnce();
    expect(mocks.pubFindMany).toHaveBeenCalledOnce();
    expect(mocks.can.mock.calls.map((call) => call[1])).toEqual([
      'menu:read',
      'menu:read',
      'menu:read',
    ]);
  });

  it('returns menu sections and items from the detail read', async () => {
    mocks.menuFindUnique.mockResolvedValue({
      id: 'menu_1',
      name: 'Dinner',
      sections: [{ id: 'section_1', items: [{ id: 'item_1' }] }],
    });

    await expect(caller().getMenu({ id: 'menu_1' })).resolves.toMatchObject({
      sections: [{ items: [{ id: 'item_1' }] }],
    });
  });

  it('serializes price-list entry money in the detail read', async () => {
    mocks.priceListFindUnique.mockResolvedValue({
      id: 'pl_1',
      versions: [{ id: 'version_1', entries: [{ id: 'entry_1', price: D('12.50') }] }],
    });

    const result = await caller().getPriceList({ id: 'pl_1' });
    expect(result.versions[0].entries[0].price).toBe('12.5');
  });

  it('reads publication scheduling and stringifies override money', async () => {
    mocks.pubFindUnique.mockResolvedValue({
      id: 'pub_1',
      windows: [{ id: 'window_1' }],
      exceptions: [{ id: 'exception_1' }],
      itemOverrides: [{ id: 'override_1', priceOverride: D('3.50') }],
    });
    mocks.windowFindMany.mockResolvedValue([{ id: 'window_1' }]);
    mocks.exceptionFindMany.mockResolvedValue([{ id: 'exception_1' }]);
    mocks.overrideFindMany.mockResolvedValue([{ id: 'override_1', priceOverride: D('4.25') }]);

    const publication = await caller().getPublication({ id: 'pub_1' });
    const windows = await caller().listAvailabilityWindows({ publicationId: 'pub_1' });
    const exceptions = await caller().listAvailabilityExceptions({ publicationId: 'pub_1' });
    const overrides = await caller().listItemOverrides({ publicationId: 'pub_1' });

    expect(publication.itemOverrides[0].priceOverride).toBe('3.5');
    expect(windows).toHaveLength(1);
    expect(exceptions).toHaveLength(1);
    expect(overrides[0].priceOverride).toBe('4.25');
  });
});

describe('createPublication — cross-org reference validation (C1/C2)', () => {
  it('rejects a publication naming a branch outside the organization', async () => {
    mocks.branchFindMany.mockResolvedValueOnce([]);
    await expect(
      caller().createPublication({ branchId: 'other_org_branch', menuId: 'menu_1' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(mocks.pubCreate).not.toHaveBeenCalled();
  });

  it('rejects a publication naming a menu outside the organization', async () => {
    mocks.menuFindMany.mockResolvedValueOnce([]);
    await expect(
      caller().createPublication({ branchId: 'branch_1', menuId: 'other_org_menu' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(mocks.pubCreate).not.toHaveBeenCalled();
  });

  it('creates a DRAFT publication for an in-scope branch + menu', async () => {
    const pub = await caller().createPublication({
      branchId: 'branch_1',
      menuId: 'menu_1',
      channels: ['DINE_IN'],
    });
    expect(pub).toMatchObject({ status: 'DRAFT', branchId: 'branch_1', menuId: 'menu_1' });
  });
});

describe('publication lifecycle (menu:publish)', () => {
  it('publishes a DRAFT and stamps publishedAt', async () => {
    const pub = await caller().publishPublication({ id: 'pub_1' });
    expect(pub.status).toBe('PUBLISHED');
    expect(mocks.pubUpdate.mock.calls[0][0].data.publishedAt).toBeInstanceOf(Date);
  });

  it('rejects publishing an already-published publication', async () => {
    mocks.pubFindUnique.mockResolvedValue({
      id: 'pub_1',
      status: 'PUBLISHED',
      branchId: 'b',
      menuId: 'm',
    });
    await expect(caller().publishPublication({ id: 'pub_1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('publishes a delivery draft as an operational channel', async () => {
    mocks.pubFindUnique.mockResolvedValue({
      id: 'pub_legacy',
      status: 'DRAFT',
      branchId: 'b',
      menuId: 'm',
      channels: ['DELIVERY'],
    });

    await expect(caller().publishPublication({ id: 'pub_legacy' })).resolves.toMatchObject({
      id: 'pub_legacy',
      status: 'PUBLISHED',
    });
    expect(mocks.pubUpdate).toHaveBeenCalled();
    expect(mocks.annotateAudit).toHaveBeenCalled();
  });

  it('allows channel remediation and retirement for legacy records', async () => {
    mocks.pubFindUnique.mockResolvedValue({
      id: 'pub_legacy',
      status: 'DRAFT',
      branchId: 'b',
      menuId: 'm',
      channels: ['DELIVERY'],
    });
    await expect(
      caller().setPublicationChannels({ id: 'pub_legacy', channels: ['TAKEAWAY'] })
    ).resolves.toMatchObject({ channels: ['TAKEAWAY'] });

    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.pubFindUnique.mockResolvedValue({
      id: 'pub_legacy',
      status: 'PUBLISHED',
      branchId: 'b',
      menuId: 'm',
      channels: ['DELIVERY'],
    });
    mocks.pubUpdate.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: where.id,
        ...data,
      })
    );
    await expect(caller().retirePublication({ id: 'pub_legacy' })).resolves.toMatchObject({
      status: 'RETIRED',
    });
  });

  it('retires only a published publication', async () => {
    mocks.pubFindUnique.mockResolvedValue({
      id: 'pub_1',
      status: 'PUBLISHED',
      branchId: 'b',
      menuId: 'm',
    });
    const pub = await caller().retirePublication({ id: 'pub_1' });
    expect(pub.status).toBe('RETIRED');
    expect(mocks.pubUpdate.mock.calls[0][0].data.retiredAt).toBeInstanceOf(Date);
  });

  it('refuses to retire a DRAFT publication', async () => {
    await expect(caller().retirePublication({ id: 'pub_1' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('setItemOverride (menu:price, C2 — availability + price only)', () => {
  it('rejects canonical content fields instead of stripping them', async () => {
    await expect(
      caller().setItemOverride({
        publicationId: 'pub_1',
        menuItemId: 'item_1',
        name: 'Branch-only rename',
        composition: [{ productId: 'shadow_component' }],
      } as Parameters<ReturnType<typeof caller>['setItemOverride']>[0])
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.overrideUpsert).not.toHaveBeenCalled();
  });

  it('rejects an item that does not belong to the published menu', async () => {
    mocks.itemFindUnique.mockResolvedValue({ id: 'item_x', section: { menuId: 'other_menu' } });
    await expect(
      caller().setItemOverride({ publicationId: 'pub_1', menuItemId: 'item_x', isAvailable: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('serializes the override price to a C4 string and defaults availability to true', async () => {
    const result = await caller().setItemOverride({
      publicationId: 'pub_1',
      menuItemId: 'item_1',
      priceOverride: '3.50',
    });
    expect(result.priceOverride).toBe('3.5');
    expect(mocks.overrideUpsert.mock.calls[0][0].create.isAvailable).toBe(true);
  });

  it('rejects a malformed override price (C4)', async () => {
    await expect(
      caller().setItemOverride({
        publicationId: 'pub_1',
        menuItemId: 'item_1',
        priceOverride: '1.234',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

// ── Effective-menu read model (the §12.3 POS-cacheable seam) ───────────────────

type WindowRow = {
  menuItemId: string | null;
  daysOfWeek: number[];
  startMinutes: number;
  endMinutes: number;
};
type ItemRow = { id: string; productId: string; variantId: string | null };

function effectiveMenuPublication(opts: {
  timezone?: string;
  channels?: string[];
  priceListId?: string | null;
  windows?: WindowRow[];
  exceptions?: { date: Date; isClosed: boolean }[];
  itemOverrides?: {
    menuItemId: string;
    isAvailable: boolean;
    priceOverride: Prisma.Decimal | null;
  }[];
  items?: ItemRow[];
}) {
  const items = (opts.items ?? [{ id: 'item_a', productId: 'prod_pub', variantId: null }]).map(
    (i) => ({
      ...i,
      displayName: null,
      nameLocalized: null,
      sortOrder: 0,
      product: {
        id: i.productId,
        name: i.productId,
        type: 'ITEM',
        status: 'ACTIVE',
        nameLocalized: null,
        descriptionLocalized: null,
      },
      variant: null,
    })
  );
  return {
    id: 'pub_1',
    status: 'PUBLISHED',
    branchId: 'branch_1',
    menuId: 'menu_1',
    priceListId: opts.priceListId === undefined ? null : opts.priceListId,
    channels: opts.channels ?? [],
    branch: { id: 'branch_1', name: 'Downtown', timezone: opts.timezone ?? 'UTC' },
    windows: opts.windows ?? [],
    exceptions: opts.exceptions ?? [],
    itemOverrides: opts.itemOverrides ?? [],
    menu: {
      id: 'menu_1',
      name: 'Dinner',
      nameLocalized: null,
      description: null,
      sections: [{ id: 'sec_1', name: 'Mains', nameLocalized: null, sortOrder: 0, items }],
    },
  };
}

/** Configure the price-list resolution mocks: version per list, entries per version. */
function withPriceLists(config: {
  defaultListId?: string | null;
  versions: Record<string, { id: string }>;
  entries: Record<string, { productId: string; variantId: string | null; price: Prisma.Decimal }[]>;
}) {
  mocks.priceListFindFirst.mockResolvedValue(
    config.defaultListId ? { id: config.defaultListId } : null
  );
  mocks.versionFindMany.mockImplementation(
    async ({ where }: { where: { priceListId: string } }) => {
      const v = config.versions[where.priceListId];
      return v
        ? [
            {
              ...v,
              versionNumber: 1,
              effectiveFrom: new Date('2020-01-01T00:00:00Z'),
              status: 'ACTIVE',
            },
          ]
        : [];
    }
  );
  mocks.entryFindMany.mockImplementation(
    async ({ where }: { where: { priceListVersionId: string } }) =>
      (config.entries[where.priceListVersionId] ?? []).map((e, idx) => ({ id: `e_${idx}`, ...e }))
  );
}

describe('effectiveMenu — winning-price precedence (override > pub list > base list)', () => {
  beforeEach(() => {
    withPriceLists({
      defaultListId: 'pl_base',
      versions: { pl_pub: { id: 'vp' }, pl_base: { id: 'vb' } },
      entries: {
        vp: [{ productId: 'prod_pub', variantId: null, price: D('20.00') }],
        vb: [
          { productId: 'prod_pub', variantId: null, price: D('99.00') },
          { productId: 'prod_base', variantId: null, price: D('5.00') },
        ],
      },
    });
  });

  it('applies override > publication list > base list and returns C4 strings', async () => {
    mocks.pubFindUnique.mockResolvedValue(
      effectiveMenuPublication({
        priceListId: 'pl_pub',
        itemOverrides: [
          { menuItemId: 'item_override', isAvailable: true, priceOverride: D('3.50') },
        ],
        items: [
          { id: 'item_override', productId: 'prod_pub', variantId: null },
          { id: 'item_pub', productId: 'prod_pub', variantId: null },
          { id: 'item_base', productId: 'prod_base', variantId: null },
          { id: 'item_none', productId: 'prod_none', variantId: null },
        ],
      })
    );

    const result = await caller().effectiveMenu({ publicationId: 'pub_1', channel: 'DINE_IN' });
    const byId = new Map(result.sections[0].items.map((i) => [i.id, i]));

    expect(byId.get('item_override')).toMatchObject({ price: '3.5', priceSource: 'OVERRIDE' });
    expect(byId.get('item_pub')).toMatchObject({ price: '20', priceSource: 'PUBLICATION_LIST' });
    expect(byId.get('item_base')).toMatchObject({ price: '5', priceSource: 'BASE_LIST' });
    expect(byId.get('item_none')).toMatchObject({ price: null, priceSource: 'NONE' });
    // Never a raw Decimal across the boundary (C4).
    for (const item of result.sections[0].items) {
      expect(typeof item.price === 'string' || item.price === null).toBe(true);
    }
  });

  it('maps an unknown publication to NOT_FOUND', async () => {
    mocks.pubFindUnique.mockResolvedValue(null);
    await expect(
      caller().effectiveMenu({ publicationId: 'gone', channel: 'DINE_IN' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('effectiveMenu — branch-timezone availability (C5, through the router)', () => {
  beforeEach(() => withPriceLists({ versions: {}, entries: {} }));

  const NY = 'America/New_York';
  function availabilityOf(
    pub: ReturnType<typeof effectiveMenuPublication>,
    channel = 'DINE_IN',
    at?: Date
  ) {
    mocks.pubFindUnique.mockResolvedValue(pub);
    return caller()
      .effectiveMenu({ publicationId: 'pub_1', channel: channel as 'DINE_IN', at })
      .then((r) => r.sections[0].items[0].available);
  }

  it('closes an item outside a same-day lunch window (branch tz)', async () => {
    // Lunch 12:00–14:00 (720–840) Thu. 2026-01-15 is a Thursday (dow 4).
    const pub = effectiveMenuPublication({
      timezone: NY,
      windows: [{ menuItemId: null, daysOfWeek: [4], startMinutes: 720, endMinutes: 840 }],
    });
    // 18:00Z = 13:00 EST → inside the window.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-01-15T18:00:00Z'))).toBe(true);
    // 20:00Z = 15:00 EST → after the window closes.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-01-15T20:00:00Z'))).toBe(false);
  });

  it('honors a cross-midnight window into the next morning (branch tz)', async () => {
    // Fri 22:00–02:00 (1320 → 120), Friday selected (dow 5). 2026-01-16 is Friday.
    const pub = effectiveMenuPublication({
      timezone: NY,
      windows: [{ menuItemId: null, daysOfWeek: [5], startMinutes: 1320, endMinutes: 120 }],
    });
    // Sat 2026-01-17 06:30Z = Sat 01:30 EST → early tail attributed to Friday → open.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-01-17T06:30:00Z'))).toBe(true);
    // Sat 2026-01-17 20:00Z = Sat 15:00 EST → Saturday is not a start day → closed.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-01-17T20:00:00Z'))).toBe(false);
  });

  it('respects DST: the same wall clock differs in winter (EST) vs summer (EDT)', async () => {
    // Window 09:00–10:00 (540–600) every day.
    const pub = effectiveMenuPublication({
      timezone: NY,
      windows: [{ menuItemId: null, daysOfWeek: [], startMinutes: 540, endMinutes: 600 }],
    });
    // Winter: 14:30Z = 09:30 EST (UTC-5) → open.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-01-15T14:30:00Z'))).toBe(true);
    // Summer: 14:30Z = 10:30 EDT (UTC-4) → after the window → closed. Same UTC clock,
    // different local time purely because of the DST offset.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-07-15T14:30:00Z'))).toBe(false);
    // Summer open needs 13:30Z = 09:30 EDT.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-07-15T13:30:00Z'))).toBe(true);
  });

  it('applies an exception date against the branch-local calendar', async () => {
    const pub = effectiveMenuPublication({
      timezone: NY,
      exceptions: [{ date: new Date('2026-12-25T00:00:00Z'), isClosed: true }],
    });
    // 2026-12-25 12:00Z = 07:00 EST on the 25th → closed by the exception.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-12-25T12:00:00Z'))).toBe(false);
    // 2026-12-26 12:00Z → a normal day, no windows → open.
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-12-26T12:00:00Z'))).toBe(true);
  });

  it('keeps supported channels available only when published', async () => {
    const pub = effectiveMenuPublication({ timezone: NY, channels: ['DINE_IN'] });
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-06-01T12:00:00Z'))).toBe(true);
  });

  it('hides an item whose override marks it unavailable', async () => {
    const pub = effectiveMenuPublication({
      timezone: NY,
      itemOverrides: [{ menuItemId: 'item_a', isAvailable: false, priceOverride: null }],
    });
    expect(await availabilityOf(pub, 'DINE_IN', new Date('2026-06-01T12:00:00Z'))).toBe(false);
  });
});

describe('availability minute bounds', () => {
  const input = { publicationId: 'pub_1', daysOfWeek: [], startMinutes: 0, endMinutes: 1440 };
  it('persists 1440 as the exclusive end of day', async () => {
    mocks.pubFindUnique.mockResolvedValue({ id: 'pub_1', menuId: 'menu_1' });
    mocks.windowCreate.mockResolvedValue({ id: 'window_1', ...input });
    await caller().addAvailabilityWindow(input);
    expect(mocks.windowCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endMinutes: 1440 }) })
    );
  });
  it.each([-1, 1441, 1.5])(
    'rejects invalid endMinutes %s before persistence',
    async (endMinutes) => {
      mocks.windowCreate.mockClear();
      await expect(caller().addAvailabilityWindow({ ...input, endMinutes })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(mocks.windowCreate).not.toHaveBeenCalled();
    }
  );
});
