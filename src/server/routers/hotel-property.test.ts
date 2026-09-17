/**
 * PROP-01 — the property router's capability gate and its mode contract.
 *
 * Two things are pinned:
 *
 * - every procedure asks the ABAC engine for `hotel:property-admin`, reads
 *   included, and refuses without it — so a hospitality user who holds
 *   reservations or folio access cannot reconfigure the property; and
 * - `modes.set` validates against the closed enum and records the value. It is
 *   deliberately not asserted to *do* anything mode-specific: MODE-01 makes the
 *   mode configuration, and the defaults it selects belong to H1-02.
 *
 * H1-06 adds `extras.*` (PROP-05) under the same gate, and pins the three things
 * the catalog owes the rest of the vertical: every write is scoped by
 * `(organizationId, branchId, id)` and never by the key alone; a taken code is
 * refused on the `code` field rather than as a constraint name; and retiring an
 * item is an `active` flag, never a delete, because folio lines name it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  findFirst: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
  count: vi.fn(async () => 15),
  extraFindMany: vi.fn(async () => []),
  extraFindFirst: vi.fn(async (): Promise<{ id: string; name: string } | null> => null),
  extraCreate: vi.fn(),
  extraUpdateMany: vi.fn(async () => ({ count: 1 })),
  queryRaw: vi.fn(async () => [{ branchId: 'branch_1' }]),
  transaction: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn(() => ({})) }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => {
  const actual = await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac');
  return { ...actual, can: mocks.can };
});
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(async () => ({ enabledModules: [] })),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => true),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));

// Accepted catalog unit cases isolate the access boundary; new selection tests
// exercise the real resolver and capabilities.
vi.mock('@/server/hotel-property-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: vi.fn(async () => ({ branchId: 'branch_1' })),
}));

import type { TRPCContext } from '../trpc';
import { hotelPropertyRouter } from './hotel-property';

const ORG = 'org_hotel_router';

const property = {
  branchId: 'branch_1',
  organizationId: ORG,
  name: 'Serena Gulberg',
  addressLine: '12 Main Boulevard',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  mode: 'HOTEL' as const,
  starCategory: 5,
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  currency: 'PKR',
  taxProfileId: 'tax_profile_1',
  languages: ['en', 'ur'],
  overbookPolicy: {},
  bookingEngineSlug: 'serena-gulberg',
  journeySettings: {},
  mealAllocationPolicy: {},
  businessDatePolicy: { roll: 'AUDIT' },
  active: true,
  createdAt: new Date('2026-09-08T00:00:00.000Z'),
  updatedAt: new Date('2026-09-08T00:00:00.000Z'),
};

const validUpdate = {
  branchId: 'branch_1',
  name: 'Serena Gulberg',
  addressLine: '12 Main Boulevard',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  starCategory: 5,
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  currency: 'PKR',
  taxProfileId: 'tax_profile_1',
  languages: ['en', 'ur'],
  bookingEngineSlug: 'serena-gulberg',
};

const validExtra = {
  branchId: 'branch_1',
  code: 'LAUNDRY',
  name: 'Laundry service',
  nameUr: 'کپڑے دھلائی',
  priceMinor: 45_000,
  taxClass: 'SERVICES',
  department: 'LAUNDRY' as const,
};

function caller() {
  // `modes.set` takes the same tenant transaction and property lock as an
  // assignment change, so the stub client has to be a transaction client too.
  // It runs the callback against itself: the lock and the ordering are pinned by
  // `hotel-property-modes.test.ts`, not here.
  const db: Record<string, unknown> = {
    hotelProperty: { findFirst: mocks.findFirst, updateMany: mocks.updateMany },
    hotelExtra: {
      findMany: mocks.extraFindMany,
      findFirst: mocks.extraFindFirst,
      create: mocks.extraCreate,
      updateMany: mocks.extraUpdateMany,
    },
    organizationRole: { count: mocks.count },
    $queryRaw: mocks.queryRaw,
  };
  db.$transaction = mocks.transaction.mockImplementation(
    async (run: (client: typeof db) => Promise<unknown>) => run(db)
  );
  return hotelPropertyRouter.createCaller({
    db,
    entitlements: { organizationId: ORG, enabledModules: ['hotel-core'] },
    session: {
      expires: 'later',
      user: { id: 'front-desk-user', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('hotelProperty capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
    mocks.findFirst.mockResolvedValue(property);
    mocks.count.mockResolvedValue(15);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it.each([
    ['get', () => caller().get({ branchId: 'branch_1' })],
    ['modes.get', () => caller().modes.get({ branchId: 'branch_1' })],
    [
      'extras.list',
      () =>
        caller().extras.list({
          branchId: 'branch_1',
          includeInactive: false,
          upsellableOnly: false,
        }),
    ],
  ])('refuses %s without hotel:property-admin', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'hotel:property-admin',
      undefined,
      expect.anything()
    );
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it('refuses update without hotel:property-admin, and writes nothing', async () => {
    await expect(caller().update(validUpdate)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a mode change without hotel:property-admin', async () => {
    await expect(caller().modes.set({ branchId: 'branch_1', mode: 'VENUE' })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      }
    );
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['extras.create', () => caller().extras.create(validExtra)],
    ['extras.update', () => caller().extras.update({ ...validExtra, id: 'extra_1' })],
    [
      'extras.setActive',
      () => caller().extras.setActive({ branchId: 'branch_1', id: 'extra_1', active: false }),
    ],
  ])('refuses %s without hotel:property-admin, and writes nothing', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.extraCreate).not.toHaveBeenCalled();
    expect(mocks.extraUpdateMany).not.toHaveBeenCalled();
  });
});

describe('hotelProperty with property administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findFirst.mockResolvedValue(property);
    mocks.extraFindMany.mockResolvedValue([]);
    mocks.extraFindFirst.mockResolvedValue(null);
    mocks.extraCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'extra_1',
      ...data,
    }));
    mocks.extraUpdateMany.mockResolvedValue({ count: 1 });
    mocks.count.mockResolvedValue(15);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('returns the property, the named mode choices and the checklist', async () => {
    const result = await caller().get({ branchId: 'branch_1' });
    expect(result.property?.branchId).toBe('branch_1');
    expect(result.modeOptions.map((option) => option.value)).toEqual([
      'HOTEL',
      'HOSTEL',
      'APARTMENT',
      'RESORT',
      'VENUE',
    ]);
    // Every choice is named for an operator; no surface prints a bare enum value.
    for (const option of result.modeOptions) {
      expect(option.label).not.toBe(option.value);
      expect(option.description.length).toBeGreaterThan(0);
    }
    // Room types stay outstanding until H1-03, so the property is not yet ready.
    expect(result.checklist.blocking.map((item) => item.key)).toEqual(['ROOM_TYPES']);
    expect(result.activationSummary).toContain('Activation is refused');
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: 'branch_1', active: true },
      })
    );
  });

  it('scopes the update by organization and branch, never by the key alone', async () => {
    await caller().update({ ...validUpdate, name: 'Serena Gulberg Annexe' });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: 'branch_1' },
        data: expect.objectContaining({ name: 'Serena Gulberg Annexe' }),
      })
    );
  });

  it('normalizes an emptied star category and tax profile to null, not to a blank', async () => {
    await caller().update({ ...validUpdate, starCategory: null, taxProfileId: null });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ starCategory: null, taxProfileId: null }),
      })
    );
  });

  it.each([
    ['checkInTime', '2pm'],
    ['checkOutTime', '25:00'],
    ['auditTime', '3'],
    ['currency', 'rupees'],
    ['bookingEngineSlug', 'Serena Gulberg'],
  ])('refuses an unusable %s before touching the database', async (field, value) => {
    await expect(
      caller().update({ ...validUpdate, [field]: value } as typeof validUpdate)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a property with no language at all', async () => {
    await expect(caller().update({ ...validUpdate, languages: [] })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });

  it('records a mode from the closed set', async () => {
    await expect(caller().modes.set({ branchId: 'branch_1', mode: 'HOSTEL' })).resolves.toEqual({
      mode: 'HOSTEL',
    });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: 'branch_1', active: true },
        data: { mode: 'HOSTEL' },
      })
    );
  });

  it('refuses a mode outside the closed set', async () => {
    await expect(
      caller().modes.set({ branchId: 'branch_1', mode: 'MOTEL' } as unknown as { mode: 'HOTEL' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed when the selected property is no longer available', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(caller().modes.get({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller().update(validUpdate)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().get({ branchId: 'branch_1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe('hotelProperty.extras (PROP-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findFirst.mockResolvedValue(property);
    mocks.extraFindMany.mockResolvedValue([]);
    mocks.extraFindFirst.mockResolvedValue(null);
    mocks.extraCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'extra_1',
      ...data,
    }));
    mocks.extraUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('lists only this property’s live catalog, with the named choices a form needs', async () => {
    const result = await caller().extras.list({
      branchId: 'branch_1',
      includeInactive: false,
      upsellableOnly: false,
    });
    expect(mocks.extraFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: 'branch_1', active: true },
      })
    );
    // UX rule 1: the page never has to print a bare enum value.
    expect(result.departmentOptions.every((option) => option.label !== option.value)).toBe(true);
    expect(result.recurrenceOptions.every((option) => option.description.length > 0)).toBe(true);
  });

  it('drops the active filter only when retired items are asked for', async () => {
    await caller().extras.list({
      branchId: 'branch_1',
      includeInactive: true,
      upsellableOnly: false,
    });
    expect(mocks.extraFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: 'branch_1' } })
    );
  });

  it('narrows to a department and to what may be offered before arrival', async () => {
    await caller().extras.list({
      branchId: 'branch_1',
      includeInactive: false,
      upsellableOnly: true,
      department: 'LAUNDRY',
    });
    expect(mocks.extraFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          branchId: 'branch_1',
          active: true,
          department: 'LAUNDRY',
          upsellable: true,
        },
      })
    );
  });

  it('creates against this organization and this property, never a bare id', async () => {
    await caller().extras.create(validExtra);
    expect(mocks.extraCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        branchId: 'branch_1',
        code: 'LAUNDRY',
        priceMinor: 45_000,
        taxClass: 'SERVICES',
        department: 'LAUNDRY',
      }),
    });
  });

  it('refuses a code this property already charges, on the code field', async () => {
    mocks.extraFindFirst.mockResolvedValue({ id: 'extra_9', name: 'Laundry service' });
    await expect(caller().extras.create(validExtra)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.extraCreate).not.toHaveBeenCalled();
    // The rejection carries a ZodError on `code`, which is what puts the message
    // under the input rather than in a toast (UX rule 11).
    await caller()
      .extras.create(validExtra)
      .catch((error: { cause?: { issues?: { path: (string | number)[] }[] } }) => {
        expect(error.cause?.issues?.map((issue) => issue.path)).toEqual([['code']]);
      });
  });

  it('lets an item keep its own code when it is edited', async () => {
    mocks.extraFindFirst.mockResolvedValue({ id: 'extra_1', name: 'Laundry service' });
    await caller().extras.update({ ...validExtra, id: 'extra_1' });
    expect(mocks.extraUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: 'branch_1', id: 'extra_1' },
      })
    );
  });

  it.each(['create', 'update'] as const)(
    'serializes a duplicate code into data.validation.code for extras.%s',
    async (operation) => {
      const { fetchRequestHandler } = await import('@trpc/server/adapters/fetch');
      const { default: superjson } = await import('superjson');
      mocks.extraFindFirst.mockResolvedValue({ id: 'extra_9', name: 'Laundry service' });
      // Match the caller fixture without changing unrelated property cases.
      // The real router and shared formatter remain untouched.
      const requestContext = {
        db: {
          hotelProperty: { findFirst: mocks.findFirst },
          hotelExtra: {
            findFirst: mocks.extraFindFirst,
            create: mocks.extraCreate,
            updateMany: mocks.extraUpdateMany,
          },
        },
        entitlements: { organizationId: ORG, enabledModules: ['hotel-core'] },
        session: {
          expires: 'later',
          user: { id: 'front-desk-user', role: 'EMPLOYEE', status: 'ACTIVE' },
        },
        organization: null,
        support: null,
        requestMeta: { ip: null, userAgent: null },
        audit: { detail: {} },
      } as unknown as TRPCContext;
      const response = await fetchRequestHandler({
        endpoint: '/api/trpc',
        req: new Request(`http://localhost/api/trpc/extras.${operation}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(
            superjson.serialize(
              operation === 'update' ? { ...validExtra, id: 'extra_1' } : validExtra
            )
          ),
        }),
        router: hotelPropertyRouter,
        createContext: () => requestContext,
      });
      const body = await response.json();
      const message =
        'This property already charges LAUNDRY — it is “Laundry service”. Retire that item or choose another code.';
      expect(response.status).toBe(400);
      expect(body.error.json.data.code).toBe('BAD_REQUEST');
      expect(body.error.json.data.validation.code).toEqual([message]);
      expect(body.error.json.message).toBe(`Code: ${message}`);
      expect(mocks.extraCreate).not.toHaveBeenCalled();
      expect(mocks.extraUpdateMany).not.toHaveBeenCalled();
    }
  );

  it('refuses an offer price on an item that may not be offered, before touching the database', async () => {
    await expect(
      caller().extras.create({ ...validExtra, upsellable: false, upsellPriceMinor: 39_000 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.extraCreate).not.toHaveBeenCalled();
  });

  it('clears the offer price when an item stops being offerable', async () => {
    await caller().extras.update({
      ...validExtra,
      id: 'extra_1',
      upsellable: false,
      upsellPriceMinor: null,
    });
    expect(mocks.extraUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ upsellPriceMinor: null }) })
    );
  });

  it.each([
    ['a code with a space', { code: 'LATE CHECKOUT' }],
    ['a department outside the closed set', { department: 'ROOM_SERVICE' }],
    ['a recurrence outside the closed set', { recurring: 'PER_WEEK' }],
    ['a price in rupees rather than paisa', { priceMinor: 450.5 }],
  ])('refuses %s before touching the database', async (_label, patch) => {
    await expect(
      caller().extras.create({ ...validExtra, ...patch } as typeof validExtra)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.extraCreate).not.toHaveBeenCalled();
  });

  it('retires an item by flag and never by delete — a folio line still names it', async () => {
    const result = await caller().extras.setActive({
      branchId: 'branch_1',
      id: 'extra_1',
      active: false,
    });
    expect(result).toEqual({ id: 'extra_1', active: false });
    expect(mocks.extraUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: 'branch_1', id: 'extra_1' },
      data: { active: false },
    });
  });

  it('says the item is not in this catalog rather than reporting a silent no-op', async () => {
    mocks.extraUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().extras.setActive({ branchId: 'branch_1', id: 'someone_elses', active: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      caller().extras.update({ ...validExtra, id: 'someone_elses' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses a catalog whose selected property disappeared', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(
      caller().extras.list({ branchId: 'branch_1', includeInactive: false, upsellableOnly: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().extras.create(validExtra)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.extraCreate).not.toHaveBeenCalled();
  });
});
