import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';
import { hotelPackageEntitlements } from '@/lib/hotel/features';
import type { EntitlementSnapshot } from '@/lib/module-catalog';
const mocks = vi.hoisted(() => ({ scope: vi.fn(), audit: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/hotel-property-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/hotel-property-scope')>()),
  requireHotelPropertyScope: mocks.scope,
}));
vi.mock('@/server/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/audit')>()),
  annotateAudit: mocks.audit,
}));
vi.mock('../trpc', async () => {
  const { initTRPC, TRPCError } = await import('@trpc/server');
  const t = initTRPC.context<{ denied?: boolean }>().create();
  const protectedProcedure = t.procedure.use(({ ctx, next }) => {
    if (ctx.denied) throw new TRPCError({ code: 'FORBIDDEN' });
    return next();
  });
  return {
    router: t.router,
    protectedProcedure,
    adminProcedure: protectedProcedure,
    capabilityProcedure: () => protectedProcedure,
    // The journey router mounted beside these audits its reads too; same stub here.
    auditedProtectedProcedure: protectedProcedure,
  };
});
import { hotelPropertyRouter } from './hotel-property';

const property = {
  branchId: 'property_1',
  organizationId: 'org_1',
  name: 'Synthetic',
  mode: 'HOTEL',
  modeOverrides: null,
  active: true,
};
const roomType = {
  id: 'type_1',
  organizationId: 'org_1',
  branchId: 'property_1',
  code: 'STD',
  name: 'Standard',
  inventoryKind: 'ROOM',
  bedsPerRoom: null,
  active: true,
};
const dormType = {
  ...roomType,
  id: 'type_dorm',
  code: 'DORM',
  inventoryKind: 'BED',
  bedsPerRoom: 4,
};
const db = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  hotelProperty: { findFirst: vi.fn() },
  hotelRoomType: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  hotelRoom: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  hotelBed: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    createMany: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(),
  },
  hotelRoomStatusEvent: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  hotelRoomBlock: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findFirstOrThrow: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
};
const entitlementsOf = (entitlements: EntitlementSnapshot) => ({
  organizationId: 'org_1',
  ...entitlements,
});
const essentials = entitlementsOf(hotelPackageEntitlements('hotel-essentials'));
const context = (entitlements = essentials, mode = 'HOTEL', modeOverrides: unknown = null) => ({
  session: { user: { id: 'actor_1', organizationId: 'org_1', role: 'ADMIN' } },
  entitlements,
  db,
  requestMeta: { ip: null },
  audit: { detail: {} },
  mode,
  modeOverrides,
});
function caller(entitlements = essentials, mode = 'HOTEL', modeOverrides: unknown = null) {
  db.hotelProperty.findFirst.mockResolvedValue({ ...property, mode, modeOverrides });
  return hotelPropertyRouter.createCaller(context(entitlements, mode, modeOverrides) as never)
    .inventory;
}
const typeInput = {
  branchId: 'property_1',
  code: 'std',
  name: 'Standard',
  inventoryKind: 'ROOM' as const,
  baseAdults: 1,
  maxAdults: 2,
  maxChildren: 0,
};
const roomInput = {
  branchId: 'property_1',
  roomTypeId: 'type_1',
  number: '101',
  reason: 'Commissioned',
};
const statusInput = {
  branchId: 'property_1',
  id: 'room_1',
  expectedStatus: 'VACANT_DIRTY' as const,
  status: 'VACANT_CLEAN' as const,
  reason: 'Cleaned',
};
const blockInput = {
  branchId: 'property_1',
  roomId: 'room_1',
  kind: 'OUT_OF_ORDER' as const,
  startDate: '2026-09-12',
  endDate: '2026-09-13',
  reason: 'Repair',
};
const first = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue(property);
  db.$transaction.mockImplementation(async (run: (value: typeof db) => Promise<unknown>) =>
    run(db)
  );
  db.$queryRaw.mockResolvedValue([{ branchId: 'property_1' }]);
  db.hotelRoomType.findMany.mockResolvedValue([roomType]);
  db.hotelRoomType.findFirst.mockResolvedValue(roomType);
  db.hotelRoomType.create.mockImplementation(async (arg: { data: object }) => ({
    id: 'type_new',
    ...arg.data,
  }));
  db.hotelRoom.findMany.mockResolvedValue([]);
  db.hotelRoom.findFirst.mockResolvedValue({ id: 'room_1', status: 'VACANT_DIRTY' });
  db.hotelRoom.findFirstOrThrow.mockImplementation(async () => ({
    id: 'room_1',
    number: '101',
    roomTypeId: 'type_1',
    beds: [],
  }));
  db.hotelRoom.create.mockResolvedValue({ id: 'room_1' });
  db.hotelRoom.updateMany.mockResolvedValue({ count: 1 });
  db.hotelRoom.count.mockResolvedValue(3);
  db.hotelBed.findMany.mockResolvedValue([]);
  db.hotelBed.findFirst.mockResolvedValue({ id: 'bed_1', status: 'VACANT_DIRTY' });
  db.hotelBed.createMany.mockResolvedValue({ count: 4 });
  db.hotelBed.updateMany.mockResolvedValue({ count: 1 });
  db.hotelBed.count.mockResolvedValue(2);
  db.hotelRoomStatusEvent.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  db.hotelRoomBlock.findMany.mockResolvedValue([]);
  db.hotelRoomBlock.findFirst.mockResolvedValue({ id: 'block_1', releasedAt: null });
  db.hotelRoomBlock.findFirstOrThrow.mockResolvedValue({ id: 'block_1', releasedAt: new Date() });
  db.hotelRoomBlock.create.mockImplementation(async (arg: { data: object }) => ({
    id: 'block_1',
    ...arg.data,
  }));
  db.hotelRoomBlock.updateMany.mockResolvedValue({ count: 1 });
});

describe('hotelProperty.inventory authorization', () => {
  const procedures: Array<[string, () => Promise<unknown>]> = [
    ['roomTypes.list', () => caller().roomTypes.list({ branchId: 'property_1' })],
    ['roomTypes.create', () => caller().roomTypes.create(typeInput)],
    ['rooms.list', () => caller().rooms.list({ branchId: 'property_1' })],
    ['rooms.create', () => caller().rooms.create(roomInput)],
    ['rooms.setStatus', () => caller().rooms.setStatus(statusInput)],
    ['rooms.history', () => caller().rooms.history({ branchId: 'property_1', roomId: 'room_1' })],
    ['beds.list', () => caller().beds.list({ branchId: 'property_1', roomId: 'room_1' })],
    ['beds.setStatus', () => caller().beds.setStatus({ ...statusInput, id: 'bed_1' })],
    ['blocks.list', () => caller().blocks.list({ branchId: 'property_1' })],
    ['blocks.create', () => caller().blocks.create(blockInput)],
    [
      'blocks.release',
      () => caller().blocks.release({ branchId: 'property_1', id: 'block_1', reason: 'Fixed' }),
    ],
  ];
  it.each(procedures)(
    '%s resolves the selected property through the scope and reads nothing when denied',
    async (_name, run) => {
      mocks.scope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.scope).toHaveBeenCalledWith(
        expect.any(Object),
        'property_1',
        expect.stringMatching(/^hotel:/)
      );
      for (const delegate of [
        db.hotelRoomType,
        db.hotelRoom,
        db.hotelBed,
        db.hotelRoomStatusEvent,
        db.hotelRoomBlock,
      ])
        for (const fn of Object.values(delegate)) expect(fn).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['roomTypes.list', () => caller().roomTypes.list({} as never)],
    [
      'roomTypes.create',
      () => caller().roomTypes.create({ ...typeInput, branchId: undefined } as never),
    ],
    ['rooms.list', () => caller().rooms.list({} as never)],
    ['rooms.create', () => caller().rooms.create({ ...roomInput, branchId: undefined } as never)],
    [
      'rooms.setStatus',
      () => caller().rooms.setStatus({ ...statusInput, branchId: undefined } as never),
    ],
    ['rooms.history', () => caller().rooms.history({ roomId: 'room_1' } as never)],
    ['beds.list', () => caller().beds.list({ roomId: 'room_1' } as never)],
    [
      'beds.setStatus',
      () => caller().beds.setStatus({ ...statusInput, id: 'bed_1', branchId: undefined } as never),
    ],
    ['blocks.list', () => caller().blocks.list({} as never)],
    [
      'blocks.create',
      () => caller().blocks.create({ ...blockInput, branchId: undefined } as never),
    ],
    ['blocks.release', () => caller().blocks.release({ id: 'block_1', reason: 'Fixed' } as never)],
  ])('%s requires an explicit property selection', async (_name, run) => {
    await expect(run()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('gates configuration reads and writes on property administration only', async () => {
    await caller().roomTypes.list({ branchId: 'property_1' });
    await caller().roomTypes.create(typeInput);
    await caller().blocks.create(blockInput);
    for (const [, , capability] of mocks.scope.mock.calls)
      expect(capability).toBe('hotel:property-admin');
  });
  it('lets housekeeping change a status only within its own statuses', async () => {
    mocks.scope.mockImplementation(async (_ctx, _branchId, capability: string) => {
      if (capability === 'hotel:property-admin') throw new TRPCError({ code: 'FORBIDDEN' });
      return property;
    });
    await expect(caller().rooms.setStatus(statusInput)).resolves.toEqual({
      id: 'room_1',
      status: 'VACANT_CLEAN',
    });
    expect(mocks.scope.mock.calls.map(([, , capability]) => capability)).toEqual([
      'hotel:property-admin',
      'hotel:housekeeping',
    ]);
    await expect(
      caller().rooms.setStatus({ ...statusInput, status: 'OUT_OF_ORDER' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('property administrator'),
    });
    expect(db.hotelRoom.updateMany).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to housekeeping for a failure that is not a denial', async () => {
    mocks.scope.mockRejectedValue(new TRPCError({ code: 'UNAUTHORIZED' }));
    await expect(caller().rooms.setStatus(statusInput)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(mocks.scope).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['rooms.setStatus', () => caller().rooms.setStatus(statusInput), () => db.hotelRoom.updateMany],
    [
      'beds.setStatus',
      () => caller().beds.setStatus({ ...statusInput, id: 'bed_1' }),
      () => db.hotelBed.updateMany,
    ],
  ] as const)(
    '%s denies a role with neither property administration nor housekeeping, and admits an administrator',
    async (_name, run, write) => {
      mocks.scope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.scope.mock.calls.map(([, , capability]) => capability)).toEqual([
        'hotel:property-admin',
        'hotel:housekeeping',
      ]);
      expect(write()).not.toHaveBeenCalled();

      mocks.scope.mockReset();
      mocks.scope.mockResolvedValue(property);
      await expect(run()).resolves.toMatchObject({ status: 'VACANT_CLEAN' });
      expect(mocks.scope.mock.calls.map(([, , capability]) => capability)).toEqual([
        'hotel:property-admin',
      ]);
      expect(write()).toHaveBeenCalledTimes(1);
    }
  );
  it('locks the property, then re-checks access, then writes', async () => {
    await caller().rooms.setStatus(statusInput);
    expect(first(db.$queryRaw)).toBeLessThan(first(mocks.scope));
    expect(first(mocks.scope)).toBeLessThan(first(db.hotelRoom.updateMany));
  });
});

describe('hotelProperty.inventory reads', () => {
  it('carries the organization and the resolved property on every query', async () => {
    await caller().rooms.list({ branchId: 'property_1' });
    expect(db.hotelRoom.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org_1',
          branchId: 'property_1',
          active: true,
        }),
      })
    );
    await caller().rooms.history({ branchId: 'property_1', roomId: 'room_1' });
    expect(db.hotelRoomStatusEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'org_1', branchId: 'property_1', roomId: 'room_1' },
      })
    );
    expect(db.user.findMany).not.toHaveBeenCalled();
    await caller().blocks.list({ branchId: 'property_1', roomId: 'room_1' });
    expect(db.hotelRoomBlock.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org_1',
          branchId: 'property_1',
          roomId: 'room_1',
          releasedAt: null,
        },
      })
    );
  });
  it('names the actor on each history line from the organization’s own members only', async () => {
    db.hotelRoomStatusEvent.findMany.mockResolvedValue([
      { id: 'event_1', actorId: 'actor_1', fromStatus: null, toStatus: 'VACANT_DIRTY' },
      { id: 'event_2', actorId: 'gone', fromStatus: 'VACANT_DIRTY', toStatus: 'VACANT_CLEAN' },
    ]);
    db.user.findMany.mockResolvedValue([{ id: 'actor_1', name: 'Front Desk' }]);
    const history = await caller().rooms.history({ branchId: 'property_1', roomId: 'room_1' });
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', id: { in: ['actor_1', 'gone'] } },
      select: { id: true, name: true },
    });
    expect(history.map((event) => event.actorName)).toEqual(['Front Desk', null]);
  });
  it.each([
    ['HOTEL', null, ['ROOM']],
    ['HOSTEL', null, ['BED']],
    ['APARTMENT', null, ['UNIT']],
    ['VENUE', null, []],
    ['HOTEL', { inventoryKinds: ['ROOM', 'BED'] }, ['ROOM', 'BED']],
  ] as const)(
    '%s with overrides %j offers exactly the configured kinds, with the room ceiling',
    async (mode, overrides, enabled) => {
      const view = await caller(essentials, mode, overrides).roomTypes.list({
        branchId: 'property_1',
      });
      expect(view.kindOptions.filter((kind) => kind.enabled).map((kind) => kind.value)).toEqual(
        enabled
      );
      for (const kind of view.kindOptions) expect(kind.label).not.toBe(kind.value);
      // Three whole rooms plus two berths, against the package's ceiling.
      expect(view.roomLimit).toEqual({ max: 50, used: 5 });
    }
  );
  it('reads the ceiling the runtime snapshot carries under the hotel-core prefix', async () => {
    // resolveOrganizationEntitlements prefixes a package link's limits with the
    // module key; an explicit organization_limits row keeps the bare key and wins.
    const bootstrapped = entitlementsOf({
      enabledModules: [...hotelPackageEntitlements('hotel-pro').enabledModules],
      limits: { 'hotel-core.hotel.rooms.max': 250, 'hotel-core.hotel.properties.max': 3 },
    });
    const view = await caller(bootstrapped).roomTypes.list({ branchId: 'property_1' });
    expect(view.kindOptions.find((kind) => kind.value === 'ROOM')).toMatchObject({
      enabled: true,
    });
    expect(view.roomLimit).toEqual({ max: 250, used: 5 });
    await expect(caller(bootstrapped).rooms.create(roomInput)).resolves.toMatchObject({
      room: { id: 'room_1' },
    });
    const overridden = entitlementsOf({
      ...bootstrapped,
      limits: { ...bootstrapped.limits, 'hotel.rooms.max': 0 },
    });
    expect((await caller(overridden).roomTypes.list({ branchId: 'property_1' })).roomLimit).toEqual(
      { max: 0, used: 5 }
    );
    db.hotelRoom.create.mockClear();
    await expect(caller(overridden).rooms.create(roomInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.hotelRoom.create).not.toHaveBeenCalled();
  });
});

describe('hotelProperty.inventory room types', () => {
  it('creates a normalized type in the selected property only', async () => {
    const result = await caller().roomTypes.create(typeInput);
    expect(result.roomType).toMatchObject({
      organizationId: 'org_1',
      branchId: 'property_1',
      code: 'STD',
      inventoryKind: 'ROOM',
    });
    expect(db.hotelRoomType.create.mock.calls[0][0].data).not.toHaveProperty('branchId', 'other');
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ targetType: 'HotelRoomType', targetId: 'type_new' })
    );
  });
  it.each([
    [
      'a bed type in a hotel',
      'HOTEL',
      null,
      { ...typeInput, inventoryKind: 'BED' as const, bedsPerRoom: 4 },
    ],
    ['a room type in a venue', 'VENUE', null, typeInput],
    [
      'a unit type outside the configured kinds',
      'HOTEL',
      { inventoryKinds: ['ROOM'] },
      { ...typeInput, inventoryKind: 'UNIT' as const },
    ],
  ])('refuses %s before any write', async (_label, mode, overrides, input) => {
    await expect(caller(essentials, mode, overrides).roomTypes.create(input)).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
        cause: { issues: [expect.objectContaining({ path: ['inventoryKind'] })] },
      }
    );
    expect(db.hotelRoomType.create).not.toHaveBeenCalled();
  });
  it('refuses a forged scope and a malformed code at the boundary', async () => {
    await expect(
      caller().roomTypes.create({ ...typeInput, organizationId: 'org_2' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().roomTypes.create({ ...typeInput, code: 'not a code' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('translates a raced code uniqueness violation into a code-field error', async () => {
    db.hotelRoomType.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: { modelName: 'HotelRoomType', target: ['organizationId', 'branchId', 'code'] },
      })
    );
    await expect(caller().roomTypes.create(typeInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { issues: [expect.objectContaining({ path: ['code'] })] },
    });
  });
  it.each([
    // Prisma 7 with @prisma/adapter-pg leaves `meta.target` unset and names the
    // columns under `driverAdapterError.cause.constraint.fields` (quoted)...
    ['parsed key columns', { fields: ['"organizationId"', '"branchId"', 'code'] }],
    // ...except on a row-level-secured table, where Postgres withholds the key
    // detail and only the message names the constraint.
    ['the constraint name alone', undefined],
  ])(
    'reads the duplicate code the pg driver adapter reports from %s',
    async (_label, constraint) => {
      db.hotelRoomType.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: '7.9.1',
          meta: {
            modelName: 'HotelRoomType',
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: {
                originalCode: '23505',
                originalMessage:
                  'duplicate key value violates unique constraint "hotel_room_types_org_branch_code_key"',
                kind: 'UniqueConstraintViolation',
                ...(constraint ? { constraint } : {}),
              },
            },
          },
        })
      );
      await expect(caller().roomTypes.create(typeInput)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'This property already has a room type with that code. Choose another.',
        cause: { issues: [expect.objectContaining({ path: ['code'] })] },
      });
    }
  );
  it('keeps an unrecognised unique violation as a conflict with the original cause', async () => {
    const error = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: '7.9.1',
      meta: { modelName: 'HotelRoomType', driverAdapterError: { name: 'DriverAdapterError' } },
    });
    db.hotelRoomType.create.mockRejectedValueOnce(error);
    await expect(caller().roomTypes.create(typeInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: error,
    });
  });
});

describe('hotelProperty.inventory rooms', () => {
  it.each([
    ['Venue package', entitlementsOf(hotelPackageEntitlements('hotel-venue'))],
    [
      'explicit zero override',
      entitlementsOf(
        hotelPackageEntitlements('hotel-essentials', { limits: { 'hotel.rooms.max': 0 } })
      ),
    ],
    ['missing room limit', entitlementsOf({ enabledModules: ['hotel-core'], limits: {} })],
    [
      'missing core module',
      entitlementsOf({ enabledModules: [], limits: { 'hotel.rooms.max': 1 } }),
    ],
  ])('denies %s before room or bed insertion', async (_label, entitlements) => {
    await expect(caller(entitlements).rooms.create(roomInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.hotelRoom.create).not.toHaveBeenCalled();
    expect(db.hotelBed.createMany).not.toHaveBeenCalled();
  });
  it('refuses a room beyond the sellable-unit ceiling, counting a dorm by its berths', async () => {
    const tight = entitlementsOf(
      hotelPackageEntitlements('hotel-essentials', { limits: { 'hotel.rooms.max': 8 } })
    );
    db.hotelRoomType.findFirst.mockResolvedValue(dormType);
    await expect(
      caller(tight, 'HOSTEL').rooms.create({ ...roomInput, roomTypeId: 'type_dorm' })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('up to 8'),
    });
    expect(db.hotelRoom.create).not.toHaveBeenCalled();
    const roomy = entitlementsOf(
      hotelPackageEntitlements('hotel-essentials', { limits: { 'hotel.rooms.max': 9 } })
    );
    await expect(
      caller(roomy, 'HOSTEL').rooms.create({ ...roomInput, roomTypeId: 'type_dorm' })
    ).resolves.toMatchObject({ room: { id: 'room_1' } });
  });
  it('serialises the ceiling count on an organization-wide lock taken after the property lock', async () => {
    const tight = entitlementsOf(
      hotelPackageEntitlements('hotel-essentials', { limits: { 'hotel.rooms.max': 5 } })
    );
    await expect(caller(tight).rooms.create(roomInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    // The property row lock is a `$queryRaw` (it reads the row); the advisory
    // lock keyed on the organization alone is the one `$executeRaw`. Order:
    // property lock, then organization lock, then the counts the refusal was
    // decided on.
    const sqlOf = (call: unknown[]) => (call[0] as readonly string[]).join('?');
    const propertyLockIndex = db.$queryRaw.mock.calls.findIndex((call) =>
      sqlOf(call).includes('FOR UPDATE')
    );
    expect(db.$queryRaw.mock.calls[propertyLockIndex]!.slice(1)).toEqual(['org_1', 'property_1']);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(db.$executeRaw.mock.calls[0]!)).toContain(
      'pg_advisory_xact_lock(hashtextextended('
    );
    expect(db.$executeRaw.mock.calls[0]!.slice(1)).toEqual(['hotel-rooms-ceiling:org_1']);
    const ceilingLock = first(db.$executeRaw)!;
    expect(db.$queryRaw.mock.invocationCallOrder[propertyLockIndex]!).toBeLessThan(ceilingLock);
    expect(ceilingLock).toBeLessThan(first(db.hotelRoom.count)!);
    expect(ceilingLock).toBeLessThan(first(db.hotelBed.count)!);
    expect(db.hotelRoom.create).not.toHaveBeenCalled();
    // The lock guards the admitted path too, not only the refusal.
    db.$executeRaw.mockClear();
    db.hotelRoom.create.mockClear();
    await caller().rooms.create(roomInput);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw.mock.calls[0]!.slice(1)).toEqual(['hotel-rooms-ceiling:org_1']);
    expect(first(db.$executeRaw)!).toBeLessThan(first(db.hotelRoom.create)!);
  });
  it('commissions a room with the server-derived scope and actor, provisioning a dorm’s berths', async () => {
    await caller().rooms.create(roomInput);
    expect(db.$queryRaw).toHaveBeenCalledWith(expect.anything(), 'actor_1', 'Commissioned');
    expect(db.hotelRoom.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        branchId: 'property_1',
        roomTypeId: 'type_1',
        inventoryKind: 'ROOM',
        number: '101',
        statusChangedBy: 'actor_1',
      }),
    });
    expect(db.hotelBed.createMany).not.toHaveBeenCalled();
    db.hotelRoomType.findFirst.mockResolvedValue(dormType);
    await caller(essentials, 'HOSTEL').rooms.create({
      ...roomInput,
      roomTypeId: 'type_dorm',
      genderPolicy: 'FEMALE',
    });
    expect(db.hotelBed.createMany).toHaveBeenCalledWith({
      data: ['1', '2', '3', '4'].map((label) => ({
        organizationId: 'org_1',
        branchId: 'property_1',
        roomId: 'room_1',
        label,
        statusChangedBy: 'actor_1',
      })),
    });
  });
  it('reports a type from another property as not found, on the field', async () => {
    db.hotelRoomType.findFirst.mockResolvedValue(null);
    await expect(caller().rooms.create(roomInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      cause: { issues: [expect.objectContaining({ path: ['roomTypeId'] })] },
    });
    expect(db.hotelRoomType.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'property_1', id: 'type_1' },
    });
  });
  it('translates a duplicate room number into a number-field error', async () => {
    db.hotelRoom.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: { modelName: 'HotelRoom', target: ['organizationId', 'branchId', 'number'] },
      })
    );
    await expect(caller().rooms.create(roomInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { issues: [expect.objectContaining({ path: ['number'] })] },
    });
    db.hotelRoom.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '7.9.1',
        meta: {
          modelName: 'HotelRoom',
          driverAdapterError: {
            name: 'DriverAdapterError',
            cause: {
              originalCode: '23505',
              kind: 'UniqueConstraintViolation',
              constraint: { index: 'hotel_rooms_org_branch_number_key' },
            },
          },
        },
      })
    );
    await expect(caller().rooms.create(roomInput)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      cause: { issues: [expect.objectContaining({ path: ['number'] })] },
    });
  });
});

describe('hotelProperty.inventory status and blocks', () => {
  it('refuses OCCUPIED and illegal moves before any lock or write', async () => {
    await expect(
      caller().rooms.setStatus({ ...statusInput, status: 'OCCUPIED' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    await expect(
      caller().rooms.setStatus({ ...statusInput, status: 'INSPECTED' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('cannot become inspected'),
    });
    expect(db.hotelRoom.updateMany).not.toHaveBeenCalled();
  });
  it('hands the actor and the reason to the database before a conditional status update', async () => {
    await caller().rooms.setStatus(statusInput);
    expect(db.$queryRaw).toHaveBeenCalledWith(expect.anything(), 'actor_1', 'Cleaned');
    expect(db.hotelRoom.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org_1',
        branchId: 'property_1',
        id: 'room_1',
        status: 'VACANT_DIRTY',
      },
      data: { status: 'VACANT_CLEAN' },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ targetType: 'HotelRoom', targetId: 'room_1' })
    );
  });
  it('reports a stale board as a conflict without writing', async () => {
    db.hotelRoom.findFirst.mockResolvedValue({ id: 'room_1', status: 'VACANT_CLEAN' });
    await expect(
      caller().rooms.setStatus({ ...statusInput, status: 'OUT_OF_ORDER' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.hotelRoom.updateMany).not.toHaveBeenCalled();
    db.hotelRoom.findFirst.mockResolvedValue({ id: 'room_1', status: 'VACANT_DIRTY' });
    db.hotelRoom.updateMany.mockResolvedValue({ count: 0 });
    await expect(caller().rooms.setStatus(statusInput)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('changes a bed through the same gate', async () => {
    await caller().beds.setStatus({ ...statusInput, id: 'bed_1' });
    expect(db.hotelBed.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'VACANT_CLEAN' } })
    );
  });
  it('opens a block with calendar days and maps the exclusion constraint to a dated conflict', async () => {
    await caller().blocks.create(blockInput);
    expect(db.hotelRoomBlock.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_1',
        branchId: 'property_1',
        roomId: 'room_1',
        kind: 'OUT_OF_ORDER',
        startDate: new Date('2026-09-12T00:00:00.000Z'),
        endDate: new Date('2026-09-13T00:00:00.000Z'),
        createdBy: 'actor_1',
      }),
    });
    db.hotelRoomBlock.create.mockRejectedValueOnce({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23P01' } } },
    });
    await expect(caller().blocks.create(blockInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('live block'),
    });
  });
  it('refuses a block that ends before it starts at the boundary', async () => {
    await expect(
      caller().blocks.create({ ...blockInput, endDate: '2026-09-12' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it('releases a block once and returns an already-released block unchanged', async () => {
    await caller().blocks.release({ branchId: 'property_1', id: 'block_1', reason: 'Fixed' });
    expect(db.hotelRoomBlock.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_1', branchId: 'property_1', id: 'block_1', releasedAt: null },
      data: expect.objectContaining({ releasedBy: 'actor_1', releaseReason: 'Fixed' }),
    });
    const released = { id: 'block_1', releasedAt: new Date('2026-09-12T00:00:00.000Z') };
    db.hotelRoomBlock.findFirst.mockResolvedValue(released);
    await expect(
      caller().blocks.release({ branchId: 'property_1', id: 'block_1', reason: 'Again' })
    ).resolves.toEqual({ block: released });
    expect(db.hotelRoomBlock.updateMany).toHaveBeenCalledTimes(1);
  });
  it('preserves unrelated database errors', async () => {
    const error = new Error('connection reset');
    db.hotelRoomBlock.create.mockRejectedValueOnce(error);
    await expect(caller().blocks.create(blockInput)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: error,
    });
  });
});
