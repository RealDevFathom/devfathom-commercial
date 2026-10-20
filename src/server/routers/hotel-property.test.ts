import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), audit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/hotel-property-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: mocks.scope,
}));
vi.mock('@/server/audit', () => ({ annotateAudit: mocks.audit }));
vi.mock('../trpc', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server');
  const t = initTRPC
    .context<{ denied?: boolean; session?: { user?: { role?: string } } }>()
    .create();
  const protectedProcedure = t.procedure.use(({ ctx, next }) => {
    if (ctx.denied) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
  const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
    if (ctx.session?.user?.role !== 'ADMIN') throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
  return {
    router: t.router,
    protectedProcedure,
    adminProcedure,
    capabilityProcedure: () => protectedProcedure,
    // The journey router mounted beside these audits its reads too; same stub here.
    auditedProtectedProcedure: protectedProcedure,
  };
});
import { hotelPropertyRouter } from './hotel-property';
import { applyHotelModeDefaults } from '@/lib/hotel/modes';
import { readHotelModeOverrides } from '@/lib/hotel/mode-overrides';
import {
  evaluateHotelFeatures,
  hotelPackageEntitlements,
  assertHotelAvailabilityDays,
} from '@/lib/hotel/features';
import { hotelExtraInput, hotelExtraRecurrenceFitsBillingCycle } from '@/lib/hotel/extras';
const version = new Date('2026-10-13T00:00:00.000Z');
const property = {
  updatedAt: version,
  branchId: 'property_1',
  organizationId: 'org_1',
  name: 'Synthetic',
  mode: 'HOTEL',
  modeOverrides: {},
  addressLine: 'Example street',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  taxProfileId: 'tax_1',
  businessDatePolicy: { rollover: 'audit' },
};
const db = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  hotelProperty: { findFirst: vi.fn(), updateMany: vi.fn() },
  hotelPropertyAssignment: { upsert: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  user: { findFirst: vi.fn() },
  organizationRole: { findFirst: vi.fn(), count: vi.fn() },
  hotelExtra: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  hotelRoomType: { count: vi.fn() },
};
const context = () => ({
  session: { user: { id: 'actor_1', organizationId: 'org_1', role: 'ADMIN' } },
  entitlements: {
    organizationId: 'org_1',
    enabledModules: ['hotel-core', 'hotel-folio'],
    limits: { 'hotel.rooms.max': 10 },
  },
  db,
  requestMeta: { ip: null },
});
const caller = () => hotelPropertyRouter.createCaller(context() as never);
const extra = {
  branchId: 'property_1',
  code: 'laundry',
  name: 'Laundry',
  priceMinor: 100,
  taxClass: 'services',
  department: 'LAUNDRY' as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue(property);
  db.$transaction.mockImplementation(async (run: (value: typeof db) => Promise<unknown>) =>
    run(db)
  );
  db.$queryRaw.mockResolvedValue([{ branchId: 'property_1' }]);
  db.hotelProperty.findFirst.mockResolvedValue(property);
  db.hotelProperty.updateMany.mockResolvedValue({ count: 1 });
  db.hotelPropertyAssignment.updateMany.mockResolvedValue({ count: 1 });
  db.hotelPropertyAssignment.upsert.mockResolvedValue({ id: 'assignment_1' });
  db.hotelPropertyAssignment.findMany.mockResolvedValue([{ branchId: 'property_1' }]);
  db.user.findFirst.mockResolvedValue({ id: 'user_2' });
  db.organizationRole.findFirst.mockResolvedValue({ id: 'role_1' });
  db.organizationRole.count.mockResolvedValue(15);
  db.hotelRoomType.count.mockResolvedValue(0);
  db.hotelExtra.findFirst.mockResolvedValue(null);
  db.hotelExtra.findMany.mockResolvedValue([]);
  db.hotelExtra.create.mockImplementation(async (arg: { data: object }) => ({
    id: 'extra_1',
    ...arg.data,
  }));
  db.hotelExtra.updateMany.mockResolvedValue({ count: 1 });
});
describe('hotel property handlers with mocked transport authorization', () => {
  it('requires explicit selection and a fresh scoped property for reads', async () => {
    await expect(caller().get()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(db.hotelProperty.findFirst).not.toHaveBeenCalled();
    const result = await caller().get({ branchId: 'property_1' });
    expect(mocks.scope).toHaveBeenCalledWith(
      expect.any(Object),
      'property_1',
      'hotel:property-admin'
    );
    expect(result.checklist.blocking.map((x) => x.key)).toEqual(['ROOM_TYPES']);
    expect(db.hotelRoomType.count).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'property_1', active: true },
    });
  });
  it('reports the property ready to activate once it holds an active room type', async () => {
    db.hotelRoomType.count.mockResolvedValue(1);
    const result = await caller().get({ branchId: 'property_1' });
    expect(result.checklist.ready).toBe(true);
    expect(result.checklist.blocking).toEqual([]);
    expect(result.activationSummary).toContain('can be activated');
  });
  it('does not read property rows when effective scope is denied', async () => {
    mocks.scope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
    await expect(caller().get({ branchId: 'other' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.hotelProperty.findFirst).not.toHaveBeenCalled();
  });
  it('locks and rechecks scope before changing modes; omitted overrides stay omitted', async () => {
    await caller().modes.set({
      expectedUpdatedAt: version,
      branchId: 'property_1',
      mode: 'HOSTEL',
    });
    expect(db.hotelProperty.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'property_1', active: true, updatedAt: version },
      data: { mode: 'HOSTEL' },
    });
    expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.scope.mock.invocationCallOrder[0]
    );
    expect(mocks.scope.mock.invocationCallOrder[0]).toBeLessThan(
      db.hotelProperty.updateMany.mock.invocationCallOrder[0]
    );
  });
  it.each([{}, { dayUse: false, inventoryKinds: [] }])(
    'replaces explicit overrides including reset and false/empty values',
    async (overrides) => {
      await caller().modes.set({
        expectedUpdatedAt: version,
        branchId: 'property_1',
        mode: 'HOTEL',
        overrides,
      });
      expect(db.hotelProperty.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { mode: 'HOTEL', modeOverrides: overrides } })
      );
    }
  );
  it('refuses stale mode writes without success audit', async () => {
    db.hotelProperty.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().modes.set({ expectedUpdatedAt: version, branchId: 'property_1', mode: 'HOTEL' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('never lets an administrator grant or revoke their own property assignment', async () => {
    await expect(
      caller().access.assign({
        branchId: 'property_1',
        userId: 'actor_1',
        organizationRoleId: 'role_1',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller().access.revoke({ branchId: 'property_1', userId: 'actor_1' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
  it('restricts delegation to active same-organization members and known roles', async () => {
    await caller().access.assign({
      branchId: 'property_1',
      userId: 'user_2',
      organizationRoleId: 'role_1',
    });
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: 'user_2', status: { in: ['ACTIVE', 'ON_LEAVE'] } },
      select: { id: true },
    });
    expect(db.organizationRole.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          id: 'role_1',
          key: expect.any(Object),
        }),
      })
    );
    expect(db.hotelPropertyAssignment.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          organizationId: 'org_1',
          branchId: 'property_1',
          userId: 'user_2',
          organizationRoleId: 'role_1',
        },
      })
    );
  });
  it('refuses delegation when the target does not belong to the allowed scope', async () => {
    db.user.findFirst.mockResolvedValue(null);
    await expect(
      caller().access.assign({
        branchId: 'property_1',
        userId: 'other_user',
        organizationRoleId: 'role_1',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.hotelPropertyAssignment.upsert).not.toHaveBeenCalled();
  });
  it('creates a normalized extra only in the selected property', async () => {
    const result = await caller().extras.create(extra);
    expect(result.extra).toMatchObject({
      organizationId: 'org_1',
      branchId: 'property_1',
      code: 'LAUNDRY',
      taxClass: 'SERVICES',
      priceMinor: 100,
    });
  });
  it('rejects duplicate catalog codes before writes', async () => {
    db.hotelExtra.findFirst.mockResolvedValue({ id: 'existing', name: 'Laundry' });
    await expect(caller().extras.create(extra)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.hotelExtra.create).not.toHaveBeenCalled();
  });
  it('rejects offer prices on non-upsellable catalog items', async () => {
    await expect(
      caller().extras.create({ ...extra, upsellable: false, upsellPriceMinor: 50 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.hotelExtra.create).not.toHaveBeenCalled();
  });
  it('retires extras through an organization/property/id predicate and never deletes', async () => {
    await caller().extras.setActive({
      expectedUpdatedAt: version,
      branchId: 'property_1',
      id: 'extra_1',
      active: false,
    });
    expect(db.hotelExtra.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'property_1', id: 'extra_1', updatedAt: version },
      data: { active: false },
    });
  });
  it('reports nonexistent or cross-property extras instead of false success', async () => {
    db.hotelExtra.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().extras.setActive({
        expectedUpdatedAt: version,
        branchId: 'property_1',
        id: 'other',
        active: false,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('lists only properties whose fresh effective scope resolves', async () => {
    db.hotelPropertyAssignment.findMany.mockResolvedValue([
      { branchId: 'denied' },
      { branchId: 'property_1' },
    ]);
    mocks.scope
      .mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }))
      .mockResolvedValueOnce(property);
    expect((await caller().extras.properties()).properties).toEqual([
      { branchId: 'property_1', name: 'Synthetic' },
    ]);
  });
  it('offers a chooser under the capability a page names, resolving each candidate with it', async () => {
    db.hotelPropertyAssignment.findMany.mockResolvedValue([
      { branchId: 'rates_denied' },
      { branchId: 'property_1' },
    ]);
    mocks.scope
      .mockRejectedValueOnce(new TRPCError({ code: 'FORBIDDEN' }))
      .mockResolvedValueOnce(property);
    const result = await caller().access.properties({ capability: 'hotel:rates' });
    expect(result).toEqual({
      organizationId: 'org_1',
      userId: 'actor_1',
      properties: [{ branchId: 'property_1', name: 'Synthetic' }],
    });
    expect(mocks.scope.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['rates_denied', 'hotel:rates'],
      ['property_1', 'hotel:rates'],
    ]);
    expect(db.hotelPropertyAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          userId: 'actor_1',
          active: true,
        }),
      })
    );
    // Any failure other than a denial is reported, never swallowed into "no properties".
    mocks.scope.mockRejectedValueOnce(new TRPCError({ code: 'INTERNAL_SERVER_ERROR' }));
    await expect(caller().access.properties({ capability: 'hotel:rates' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
    await expect(
      caller().access.properties({ capability: 'not:a-hotel-capability' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
describe('Hotel mode and catalog value rules', () => {
  it('preserves explicit false/empty overrides without aliasing arrays', () => {
    const overrides = { dayUse: false, inventoryKinds: [] };
    const a = applyHotelModeDefaults('HOTEL', overrides);
    expect(a.dayUse).toBe(false);
    expect(a.inventoryKinds).toEqual([]);
    expect(a.inventoryKinds).not.toBe(overrides.inventoryKinds);
    expect(applyHotelModeDefaults('HOSTEL').inventoryKinds).toEqual(['BED']);
    expect(applyHotelModeDefaults('VENUE').inventoryKinds).toEqual([]);
  });
  it('rejects malformed stored overrides and removes undefined values', () => {
    expect(() => readHotelModeOverrides({ unregistered: true })).toThrow();
    expect(() => readHotelModeOverrides({ dayUse: 'yes' })).toThrow();
    expect(readHotelModeOverrides({ dayUse: undefined })).toEqual({});
  });
  it('configuration never grants missing entitlements', () => {
    const config = applyHotelModeDefaults('RESORT');
    const features = evaluateHotelFeatures(
      config,
      hotelPackageEntitlements('hotel-essentials', { enabledModules: [] })
    );
    expect(Object.values(features).every((value) => !value)).toBe(true);
    expect(() => assertHotelAvailabilityDays(features, 1)).toThrow();
    expect(() => assertHotelAvailabilityDays(features, 0)).not.toThrow();
  });
  it.each(['NIGHTLY', 'SLOT'] as const)('refuses periodic charges for %s billing', (cycle) => {
    expect(hotelExtraRecurrenceFitsBillingCycle('PER_PERIOD', cycle)).toBe(false);
  });
  it.each([-1, 2147483648])('refuses out-of-range price %s', (priceMinor) => {
    expect(hotelExtraInput.safeParse({ ...extra, priceMinor }).success).toBe(false);
  });
});

describe('Hotel mutation concurrency contracts', () => {
  const propertyInput = {
    ...property,
    currency: 'PKR',
    languages: ['en'],
    bookingEngineSlug: 'example-property',
    expectedUpdatedAt: version,
  };
  const mutate = {
    property: () => caller().update(propertyInput),
    create: () => caller().extras.create(extra),
    update: () => caller().extras.update({ ...extra, id: 'extra_1', expectedUpdatedAt: version }),
    retire: () =>
      caller().extras.setActive({
        branchId: 'property_1',
        id: 'extra_1',
        active: false,
        expectedUpdatedAt: version,
      }),
  };
  it.each(['property', 'create', 'update', 'retire'] as const)(
    '%s locks then rechecks access, refusing a revoked assignment before write',
    async (kind) => {
      mocks.scope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      await expect(mutate[kind]()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.scope.mock.invocationCallOrder[0]
      );
      expect(db.hotelProperty.updateMany).not.toHaveBeenCalled();
      expect(db.hotelExtra.create).not.toHaveBeenCalled();
      expect(db.hotelExtra.updateMany).not.toHaveBeenCalled();
    }
  );
  it('requires the exact property revision and rejects stale facts', async () => {
    db.hotelProperty.updateMany.mockResolvedValue({ count: 0 });
    await expect(caller().update(propertyInput)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.hotelProperty.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_1',
          branchId: 'property_1',
          active: true,
          updatedAt: version,
        },
      })
    );
  });
  it.each([
    ['an unknown zone', 'Mars/Phobos'],
    ['free text', 'not a timezone'],
    ['a blank zone', '   '],
    ['a null zone', null],
    ['a missing zone', undefined],
  ])('refuses %s before any lock, scope check or write', async (_label, timezone) => {
    await expect(caller().update({ ...propertyInput, timezone } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(db.hotelProperty.findFirst).not.toHaveBeenCalled();
    expect(db.hotelProperty.updateMany).not.toHaveBeenCalled();
  });
  it('reports an unknown zone on the timezone field', async () => {
    const unknownZone = { ...propertyInput, timezone: 'Mars/Phobos' };
    await expect(caller().update(unknownZone)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ['timezone'], message: 'Choose a valid IANA timezone.' }),
        ]),
      },
    });
  });
  it('writes a trimmed valid zone through the locked revision update', async () => {
    await caller().update({ ...propertyInput, timezone: '  America/New_York  ' });
    expect(db.hotelProperty.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ timezone: 'America/New_York' }) })
    );
  });
  it('prevents a stale extra edit from undoing a later retirement', async () => {
    const stored = { active: false, updatedAt: new Date(version.getTime() + 1) };
    db.hotelExtra.updateMany.mockImplementation(
      async ({ where, data }: { where: { updatedAt: Date }; data: { active: boolean } }) => {
        if (where.updatedAt.getTime() !== stored.updatedAt.getTime()) return { count: 0 };
        stored.active = data.active;
        return { count: 1 };
      }
    );
    await expect(
      caller().extras.update({ ...extra, id: 'extra_1', active: true, expectedUpdatedAt: version })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(stored.active).toBe(false);
  });
  it('translates a raced code uniqueness violation into code-field validation', async () => {
    db.hotelExtra.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: { modelName: 'HotelExtra', target: ['organizationId', 'branchId', 'code'] },
      })
    );
    await expect(caller().extras.create(extra)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { issues: expect.arrayContaining([expect.objectContaining({ path: ['code'] })]) },
    });
  });
  it('translates the same violation as the pg driver adapter reports it', async () => {
    db.hotelExtra.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: {
          modelName: 'HotelExtra',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '23505',
              // Postgres withholds the key detail on a row-level-secured table,
              // so only the message names the constraint.
              originalMessage:
                'duplicate key value violates unique constraint "hotel_extras_org_branch_code_key"',
              kind: 'UniqueConstraintViolation',
            },
          },
        },
      })
    );
    await expect(caller().extras.create(extra)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { issues: expect.arrayContaining([expect.objectContaining({ path: ['code'] })]) },
    });
  });
  it('preserves unrelated database errors', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('other unique', {
      code: 'P2002',
      clientVersion: '7.9.1',
      meta: { modelName: 'HotelExtra', target: ['organizationId', 'id'] },
    });
    db.hotelExtra.create.mockRejectedValueOnce(error);
    await expect(caller().extras.create(extra)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: error,
    });
  });
});
