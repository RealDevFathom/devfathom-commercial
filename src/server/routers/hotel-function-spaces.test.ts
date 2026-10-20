/**
 * PROP-07 — `hotelProperty.spaces.*`: its gates and its refusals.
 *
 * Pinned here:
 *
 * - every procedure needs the `hotel-banquets` module and resolves the selected
 *   property through the scope with `hotel:property-admin`, reads included; a
 *   denied scope reads and writes nothing;
 * - writes also need the property's real configuration to enable function
 *   spaces (mode plus overrides against the entitlements), checked inside the
 *   lock after the scope, and lock → re-check → write holds;
 * - every space and booking statement carries the organization and the
 *   resolved property, including the SQL hold;
 * - the constraints an operator can hit — a duplicate name, the exclusion
 *   constraint refusing a widened buffer, a busy hall — arrive as sentences on
 *   their field, and a race past the availability read is still a conflict.
 */
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
  };
});
import { hotelPropertyRouter } from './hotel-property';

const ORG = 'org_1';
const BRANCH = 'property_1';
const version = new Date('2026-10-01T10:00:00.000Z');
const property = {
  branchId: BRANCH,
  organizationId: ORG,
  name: 'Synthetic Venue',
  timezone: 'Asia/Karachi',
  mode: 'VENUE',
  modeOverrides: null,
  active: true,
};
const storedSpace = {
  id: 'space_crystal',
  organizationId: ORG,
  branchId: BRANCH,
  name: 'Crystal Hall',
  nameUr: 'کرسٹل ہال',
  layouts: [
    { layout: 'Theatre', capacity: 300 },
    { layout: 'Banquet', capacity: 220 },
  ],
  pricing: { hourlyMinor: 4_500_000 },
  setupMinutes: 90,
  teardownMinutes: 60,
  active: true,
  updatedAt: version,
};
const storedBooking = {
  id: 'booking_walima',
  spaceId: 'space_crystal',
  kind: 'FUNCTION',
  startsAt: new Date('2026-10-01T12:00:00.000Z'),
  endsAt: new Date('2026-10-01T16:00:00.000Z'),
  ref: { label: 'Walima' },
  createdBy: 'actor_1',
  createdAt: version,
};
const validSpaceInput = {
  branchId: BRANCH,
  name: 'Crystal Hall',
  nameUr: 'کرسٹل ہال',
  layouts: [{ layout: 'Theatre', capacity: 300 }],
  pricing: { hourlyMinor: 4_500_000 },
  setupMinutes: 90,
  teardownMinutes: 60,
};
const window = {
  branchId: BRANCH,
  spaceId: 'space_crystal',
  startsAt: '2026-10-01T16:00:00.000Z',
  endsAt: '2026-10-01T20:00:00.000Z',
};
const hold = { ...window, label: 'Khan mehndi — tentative' };

const db = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  hotelProperty: { findFirst: vi.fn() },
  hotelFunctionSpace: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  hotelSpaceBooking: { findMany: vi.fn(), deleteMany: vi.fn() },
};
const entitlementsOf = (entitlements: EntitlementSnapshot) => ({
  organizationId: ORG,
  ...entitlements,
});
const venue = entitlementsOf(hotelPackageEntitlements('hotel-venue'));
const pro = entitlementsOf(hotelPackageEntitlements('hotel-pro'));
const context = (entitlements = venue, mode = 'VENUE', modeOverrides: unknown = null) => ({
  session: { user: { id: 'actor_1', organizationId: ORG, role: 'ADMIN' } },
  entitlements,
  db,
  requestMeta: { ip: null },
  audit: { detail: {} },
  mode,
  modeOverrides,
});
function caller(entitlements = venue, mode = 'VENUE', modeOverrides: unknown = null) {
  db.hotelProperty.findFirst.mockResolvedValue({ ...property, mode, modeOverrides });
  return hotelPropertyRouter.createCaller(context(entitlements, mode, modeOverrides) as never)
    .spaces;
}
const first = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];
const sqlOf = (call: unknown[]) => (call[0] as readonly string[]).join('?');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue(property);
  db.$transaction.mockImplementation(async (run: (value: typeof db) => Promise<unknown>) =>
    run(db)
  );
  // The property lock reads a row; the SQL hold returns the inserted booking.
  db.$queryRaw.mockImplementation(async (strings: readonly string[], ...values: unknown[]) =>
    strings.join('?').includes('INSERT INTO "hotel_space_bookings"')
      ? [
          {
            ...storedBooking,
            id: 'booking_new',
            kind: values[5],
            startsAt: values[3],
            endsAt: values[4],
            ref: JSON.parse(values[6] as string),
            createdBy: values[7],
          },
        ]
      : [{ branchId: BRANCH }]
  );
  db.hotelFunctionSpace.findFirst.mockResolvedValue(storedSpace);
  db.hotelFunctionSpace.findMany.mockResolvedValue([storedSpace]);
  db.hotelFunctionSpace.create.mockImplementation(async ({ data }: { data: object }) => ({
    ...storedSpace,
    ...data,
  }));
  db.hotelFunctionSpace.updateMany.mockResolvedValue({ count: 1 });
  db.hotelSpaceBooking.findMany.mockResolvedValue([]);
  db.hotelSpaceBooking.deleteMany.mockResolvedValue({ count: 1 });
});

describe('hotelProperty.spaces gates', () => {
  const procedures: Array<[string, (c: ReturnType<typeof caller>) => Promise<unknown>]> = [
    ['list', (c) => c.list({ branchId: BRANCH })],
    ['availability', (c) => c.availability(window)],
    ['bookings.list', (c) => c.bookings.list({ branchId: BRANCH })],
    ['create', (c) => c.create(validSpaceInput)],
    [
      'update',
      (c) => c.update({ ...validSpaceInput, id: 'space_crystal', expectedUpdatedAt: version }),
    ],
    [
      'setActive',
      (c) =>
        c.setActive({
          branchId: BRANCH,
          spaceId: 'space_crystal',
          active: false,
          expectedUpdatedAt: version,
        }),
    ],
    ['bookings.hold', (c) => c.bookings.hold(hold)],
    ['bookings.release', (c) => c.bookings.release({ branchId: BRANCH, bookingId: 'booking_1' })],
  ];
  const nothingWritten = () => {
    expect(db.hotelFunctionSpace.create).not.toHaveBeenCalled();
    expect(db.hotelFunctionSpace.updateMany).not.toHaveBeenCalled();
    expect(db.hotelSpaceBooking.deleteMany).not.toHaveBeenCalled();
    expect(db.$queryRaw.mock.calls.some((call) => sqlOf(call).includes('INSERT'))).toBe(false);
  };
  it.each(procedures)(
    '%s refuses a workspace without Banquets and Events before touching the property',
    async (_name, run) => {
      await expect(run(caller(pro))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('Banquets and Events'),
      });
      expect(mocks.scope).not.toHaveBeenCalled();
      expect(db.hotelFunctionSpace.findMany).not.toHaveBeenCalled();
      nothingWritten();
    }
  );
  it.each(procedures)(
    '%s resolves the selected property through the scope with hotel:property-admin and touches nothing when denied',
    async (_name, run) => {
      mocks.scope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      await expect(run(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), BRANCH, 'hotel:property-admin');
      expect(db.hotelFunctionSpace.findMany).not.toHaveBeenCalled();
      expect(db.hotelSpaceBooking.findMany).not.toHaveBeenCalled();
      nothingWritten();
    }
  );
  const writes = procedures.filter(([name]) =>
    ['create', 'update', 'setActive', 'bookings.hold', 'bookings.release'].includes(name)
  );
  it.each(writes)(
    '%s refuses a property not configured for function spaces, inside the lock, after the scope',
    async (_name, run) => {
      // Banquets licensed, but the property runs as a hotel with no override.
      await expect(run(caller(venue, 'HOTEL'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('not configured to sell function spaces'),
      });
      expect(first(db.$queryRaw)).toBeLessThan(first(mocks.scope)!);
      nothingWritten();
    }
  );
  it('admits a hotel-mode property whose override turns function spaces on', async () => {
    await expect(
      caller(venue, 'HOTEL', { functionSpaces: true }).create(validSpaceInput)
    ).resolves.toMatchObject({ space: { name: 'Crystal Hall' } });
  });
  it('reads for a property that may not write, saying so', async () => {
    const result = await caller(venue, 'HOTEL').list({ branchId: BRANCH });
    expect(result.enabled).toBe(false);
    expect(result.spaces).toHaveLength(1);
  });
  it('locks the property, then re-checks access, then writes', async () => {
    await caller().create(validSpaceInput);
    expect(first(db.$queryRaw)).toBeLessThan(first(mocks.scope)!);
    expect(first(mocks.scope)).toBeLessThan(first(db.hotelFunctionSpace.create)!);
    expect(db.$queryRaw.mock.calls[0]!.slice(1)).toEqual([ORG, BRANCH]);
  });
});

describe('hotelProperty.spaces reads', () => {
  it('lists the property’s spaces and diary, scoped by organization and branch, with the named kinds', async () => {
    db.hotelSpaceBooking.findMany.mockResolvedValue([storedBooking]);
    const result = await caller().list({ branchId: BRANCH });
    expect(result).toMatchObject({ branchId: BRANCH, timezone: 'Asia/Karachi', enabled: true });
    expect(result.spaces.map((space) => space.name)).toEqual(['Crystal Hall']);
    expect(result.spaces[0]!.maxCapacity).toBe(300);
    expect(result.bookings).toEqual([{ ...storedBooking, label: 'Walima', ref: undefined }]);
    expect(result.kindOptions).toEqual([
      { value: 'HOLD', label: 'Tentative hold' },
      { value: 'FUNCTION', label: 'Confirmed function' },
    ]);
    expect(db.hotelFunctionSpace.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: BRANCH } })
    );
    expect(db.hotelSpaceBooking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: ORG, branchId: BRANCH }),
      })
    );
  });
  it('answers availability with the buffered window and the time the space is next free', async () => {
    const free = await caller().availability(window);
    expect(free.available).toBe(true);
    expect(free.reason).toBeNull();
    expect(free.buffered.startsAt.toISOString()).toBe('2026-10-01T14:30:00.000Z');
    expect(free.buffered.endsAt.toISOString()).toBe('2026-10-01T21:00:00.000Z');
    db.hotelSpaceBooking.findMany.mockResolvedValue([storedBooking]);
    const busy = await caller().availability(window);
    expect(busy.available).toBe(false);
    expect(busy.conflicts.map((conflict) => conflict.id)).toEqual(['booking_walima']);
    // 16:00Z end + 60 minutes of teardown = 17:00Z = 22:00 in Karachi.
    expect(busy.reason).toContain('Crystal Hall is already booked');
    expect(busy.reason).toContain('22:00');
  });
  it('refuses a window that does not end after it starts and a space of another property', async () => {
    await expect(
      caller().availability({ ...window, endsAt: window.startsAt })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    db.hotelFunctionSpace.findFirst.mockResolvedValue(null);
    await expect(caller().availability(window)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.hotelFunctionSpace.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: BRANCH, id: 'space_crystal' },
      })
    );
  });
});

describe('hotelProperty.spaces writes', () => {
  it('creates a space against the selected property and records it', async () => {
    const result = await caller().create(validSpaceInput);
    expect(db.hotelFunctionSpace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          branchId: BRANCH,
          setupMinutes: 90,
          teardownMinutes: 60,
          layouts: [{ layout: 'Theatre', capacity: 300 }],
        }),
      })
    );
    expect(result.space.maxCapacity).toBe(300);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'HotelFunctionSpace', action: 'hotel.spaces.create' })
    );
  });
  it('scopes an update by organization, property, id and the version the editor saw', async () => {
    await caller().update({ ...validSpaceInput, id: 'space_crystal', expectedUpdatedAt: version });
    expect(db.hotelFunctionSpace.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: BRANCH, id: 'space_crystal', updatedAt: version },
      })
    );
  });
  it('reports a stale version or a vanished space as a conflict without writing', async () => {
    db.hotelFunctionSpace.findFirst.mockResolvedValue({
      ...storedSpace,
      updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    });
    await expect(
      caller().update({ ...validSpaceInput, id: 'space_crystal', expectedUpdatedAt: version })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.hotelFunctionSpace.updateMany).not.toHaveBeenCalled();
    db.hotelFunctionSpace.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().setActive({
        branchId: BRANCH,
        spaceId: 'space_gone',
        active: false,
        expectedUpdatedAt: version,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('retires a space rather than deleting it, and restores it', async () => {
    await expect(
      caller().setActive({
        branchId: BRANCH,
        spaceId: 'space_crystal',
        active: false,
        expectedUpdatedAt: version,
      })
    ).resolves.toEqual({ id: 'space_crystal', active: false });
    expect(db.hotelFunctionSpace.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, id: 'space_crystal', updatedAt: version },
      data: { active: false },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'hotel.spaces.retire' })
    );
    await caller().setActive({
      branchId: BRANCH,
      spaceId: 'space_crystal',
      active: true,
      expectedUpdatedAt: version,
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'hotel.spaces.restore' })
    );
  });
  it('names a duplicate space on the name field instead of leaking a unique-constraint error', async () => {
    db.hotelFunctionSpace.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: '23505',
              originalMessage:
                'duplicate key value violates unique constraint "hotel_function_spaces_org_branch_name_key"',
            },
          },
        },
      })
    );
    const error = await caller()
      .create(validSpaceInput)
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('Crystal Hall'),
    });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['name'] })],
    });
  });
  it('explains an exclusion violation on a space write as buffers that would collide bookings', async () => {
    // 23P01 arrives from the driver beneath Prisma's generic error.
    db.hotelFunctionSpace.updateMany.mockRejectedValue({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23P01' } } },
    });
    const error = await caller()
      .update({
        ...validSpaceInput,
        id: 'space_crystal',
        setupMinutes: 600,
        expectedUpdatedAt: version,
      })
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('overlap bookings'),
    });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['setupMinutes'] })],
    });
  });
  it('re-throws a database error it does not understand rather than dressing it up', async () => {
    db.hotelFunctionSpace.updateMany.mockRejectedValue(new Error('connection terminated'));
    await expect(
      caller().update({ ...validSpaceInput, id: 'space_crystal', expectedUpdatedAt: version })
    ).rejects.toThrow(/connection terminated/);
  });
  it.each([
    ['no layouts', { layouts: [] }],
    ['a capacity of zero', { layouts: [{ layout: 'Theatre', capacity: 0 }] }],
    ['a fractional price', { pricing: { hourlyMinor: 4500.5 } }],
    ['a buffer longer than a day', { setupMinutes: 1441 }],
  ])('refuses %s before touching the database', async (_label, invalid) => {
    await expect(
      caller().create({ ...validSpaceInput, ...invalid } as typeof validSpaceInput)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(db.hotelFunctionSpace.create).not.toHaveBeenCalled();
  });
});

describe('hotelProperty.spaces bookings', () => {
  it('claims a hold in SQL under the property, the space and the actor, after the availability read', async () => {
    const result = await caller().bookings.hold(hold);
    const insert = db.$queryRaw.mock.calls.find((call) => sqlOf(call).includes('INSERT'))!;
    expect(insert.slice(1)).toEqual([
      ORG,
      BRANCH,
      'space_crystal',
      new Date(hold.startsAt),
      new Date(hold.endsAt),
      'HOLD',
      JSON.stringify({ label: hold.label }),
      'actor_1',
    ]);
    expect(first(db.hotelSpaceBooking.findMany)).toBeLessThan(
      db.$queryRaw.mock.invocationCallOrder[db.$queryRaw.mock.calls.indexOf(insert)]!
    );
    expect(result.booking).toMatchObject({
      id: 'booking_new',
      kind: 'HOLD',
      label: hold.label,
      createdBy: 'actor_1',
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'HotelSpaceBooking',
        targetId: 'booking_new',
        action: 'hotel.spaces.booking.create',
      })
    );
  });
  it('refuses a busy hall with the time it is next free, on the start field, and writes nothing', async () => {
    db.hotelSpaceBooking.findMany.mockResolvedValue([storedBooking]);
    const error = await caller()
      .bookings.hold(hold)
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('next free at'),
    });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['startsAt'] })],
    });
    expect(db.$queryRaw.mock.calls.some((call) => sqlOf(call).includes('INSERT'))).toBe(false);
  });
  it('reports a race past the availability read as a conflict, never a database error', async () => {
    db.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
      if (strings.join('?').includes('INSERT')) {
        throw { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23P01' } } } };
      }
      return [{ branchId: BRANCH }];
    });
    await expect(caller().bookings.hold(hold)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('a moment ago'),
    });
  });
  it('refuses a hold on a retired or unknown space on the space field', async () => {
    db.hotelFunctionSpace.findFirst.mockResolvedValue({ ...storedSpace, active: false });
    await expect(caller().bookings.hold(hold)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('retired'),
    });
    db.hotelFunctionSpace.findFirst.mockResolvedValue(null);
    await expect(caller().bookings.hold(hold)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(db.$queryRaw.mock.calls.some((call) => sqlOf(call).includes('INSERT'))).toBe(false);
  });
  it('refuses a claim that ends before it starts or runs past a week at the boundary', async () => {
    await expect(caller().bookings.hold({ ...hold, endsAt: hold.startsAt })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller().bookings.hold({ ...hold, endsAt: '2026-10-09T16:00:00.000Z' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.scope).not.toHaveBeenCalled();
  });
  it('releases only a hold of the selected property and says when there is none', async () => {
    await expect(
      caller().bookings.release({ branchId: BRANCH, bookingId: 'booking_1' })
    ).resolves.toEqual({ id: 'booking_1', released: true });
    expect(db.hotelSpaceBooking.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, id: 'booking_1', kind: 'HOLD' },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'hotel.spaces.booking.release', operation: 'DELETE' })
    );
    db.hotelSpaceBooking.deleteMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().bookings.release({ branchId: BRANCH, bookingId: 'booking_function' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('lists the diary for one space of the selected property', async () => {
    await caller().bookings.list({ branchId: BRANCH, spaceId: 'space_crystal' });
    expect(db.hotelSpaceBooking.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          branchId: BRANCH,
          spaceId: 'space_crystal',
        }),
      })
    );
  });
});
