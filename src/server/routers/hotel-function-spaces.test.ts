/**
 * PROP-07 — `hotelProperty.spaces.*`: its capability gate and its refusals.
 *
 * Three things are pinned:
 *
 * - every procedure asks the ABAC engine for `hotel:property-admin`, **reads
 *   included** — a hall's price list is commercial configuration, so a front-desk
 *   or reservations user cannot read or change it;
 * - every space/booking statement carries the tenant and server-resolved property,
 *   including ID reads and writes; and
 * - the two constraints an operator can hit — a duplicate name and the exclusion
 *   constraint refusing a widened buffer — arrive as sentences they can act on,
 *   not as database errors.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  findFirst: vi.fn(),
  spaceFindFirst: vi.fn(),
  spaceFindMany: vi.fn(),
  spaceCreate: vi.fn(),
  spaceUpdateMany: vi.fn(),
  bookingFindMany: vi.fn(),
  count: vi.fn(async () => 15),
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
}));

import { Prisma } from '@/generated/prisma/client';
import type { TRPCContext } from '../trpc';
import { hotelPropertyRouter } from './hotel-property';

const ORG = 'org_hotel_spaces_router';

const property = {
  branchId: 'branch_1',
  organizationId: ORG,
  name: 'Serena Gulberg',
  mode: 'HOTEL' as const,
  active: true,
  createdAt: new Date('2026-09-08T00:00:00.000Z'),
};

const storedSpace = {
  id: 'space_crystal',
  organizationId: ORG,
  branchId: 'branch_1',
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
};

const validSpaceInput = {
  name: 'Crystal Hall',
  nameUr: 'کرسٹل ہال',
  layouts: [{ layout: 'Theatre', capacity: 300 }],
  pricing: { hourlyMinor: 4_500_000 },
  setupMinutes: 90,
  teardownMinutes: 60,
};

function caller() {
  return hotelPropertyRouter.createCaller({
    db: {
      hotelProperty: { findFirst: mocks.findFirst, updateMany: vi.fn() },
      hotelFunctionSpace: {
        findFirst: mocks.spaceFindFirst,
        findMany: mocks.spaceFindMany,
        create: mocks.spaceCreate,
        updateMany: mocks.spaceUpdateMany,
      },
      hotelSpaceBooking: { findMany: mocks.bookingFindMany },
      organizationRole: { count: mocks.count },
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
  } as unknown as TRPCContext);
}

const window = {
  spaceId: 'space_crystal',
  startsAt: '2026-10-01T16:00:00.000Z',
  endsAt: '2026-10-01T20:00:00.000Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.findFirst.mockResolvedValue(property);
  mocks.spaceFindFirst.mockResolvedValue(storedSpace);
  mocks.spaceFindMany.mockResolvedValue([storedSpace]);
  mocks.spaceCreate.mockResolvedValue(storedSpace);
  mocks.spaceUpdateMany.mockResolvedValue({ count: 1 });
  mocks.bookingFindMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(15);
});

describe('hotelProperty.spaces capability gate', () => {
  beforeEach(() => mocks.can.mockResolvedValue(false));

  it.each([
    ['list', () => caller().spaces.list()],
    ['availability', () => caller().spaces.availability(window)],
  ])('refuses %s without hotel:property-admin', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'hotel:property-admin',
      undefined,
      expect.anything()
    );
    expect(mocks.spaceFindMany).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.spaceFindFirst).not.toHaveBeenCalled();
    expect(mocks.bookingFindMany).not.toHaveBeenCalled();
  });

  it('refuses every write without hotel:property-admin, and writes nothing', async () => {
    await expect(caller().spaces.create(validSpaceInput)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller().spaces.update({ ...validSpaceInput, id: 'space_crystal' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().spaces.deactivate({ spaceId: 'space_crystal' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.spaceCreate).not.toHaveBeenCalled();
    expect(mocks.spaceUpdateMany).not.toHaveBeenCalled();
  });
});

describe('hotelProperty.spaces with property administration', () => {
  it('lists the property’s spaces, scoped by organization and branch', async () => {
    const result = await caller().spaces.list();
    expect(result.branchId).toBe('branch_1');
    expect(result.spaces.map((space) => space.name)).toEqual(['Crystal Hall']);
    expect(result.spaces[0]!.maxCapacity).toBe(300);
    expect(mocks.spaceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: 'branch_1' } })
    );
  });

  it('creates a space against the property’s own branch', async () => {
    await caller().spaces.create(validSpaceInput);
    expect(mocks.spaceCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          branchId: 'branch_1',
          setupMinutes: 90,
          teardownMinutes: 60,
        }),
      })
    );
  });

  it('scopes the update by organization, resolved property and id', async () => {
    await caller().spaces.update({ ...validSpaceInput, id: 'space_crystal' });
    expect(mocks.spaceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: property.branchId, id: 'space_crystal' },
      })
    );
  });

  it('retires a space rather than deleting it', async () => {
    await expect(caller().spaces.deactivate({ spaceId: 'space_crystal' })).resolves.toEqual({
      id: 'space_crystal',
      active: false,
    });
    expect(mocks.spaceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: property.branchId, id: 'space_crystal' },
        data: { active: false },
      })
    );
  });

  it('says the space is gone rather than reporting a silent no-op', async () => {
    mocks.spaceUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().spaces.update({ ...validSpaceInput, id: 'space_gone' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller().spaces.deactivate({ spaceId: 'space_gone' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('names a duplicate space instead of leaking a unique-constraint error', async () => {
    mocks.spaceCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      })
    );
    await expect(caller().spaces.create(validSpaceInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Crystal Hall'),
    });
  });

  it('explains an exclusion violation as a buffer that would collide bookings', async () => {
    // 23P01 arrives from the driver beneath Prisma's generic error, exactly as the
    // roster's overlap constraint does.
    mocks.spaceUpdateMany.mockRejectedValue({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23P01' } } },
    });
    await expect(
      caller().spaces.update({ ...validSpaceInput, id: 'space_crystal', setupMinutes: 600 })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('overlap bookings'),
    });
  });

  it('re-throws a database error it does not understand rather than dressing it up', async () => {
    mocks.spaceUpdateMany.mockRejectedValue(new Error('connection terminated'));
    await expect(
      caller().spaces.update({ ...validSpaceInput, id: 'space_crystal' })
    ).rejects.toThrow(/connection terminated/);
  });

  it.each([
    ['no layouts', { layouts: [] }],
    ['a capacity of zero', { layouts: [{ layout: 'Theatre', capacity: 0 }] }],
    ['a fractional price', { pricing: { hourlyMinor: 4500.5 } }],
    ['a buffer longer than a day', { setupMinutes: 1441 }],
  ])('refuses %s before touching the database', async (_label, invalid) => {
    await expect(
      caller().spaces.create({ ...validSpaceInput, ...invalid } as typeof validSpaceInput)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.spaceCreate).not.toHaveBeenCalled();
  });

  it('answers availability with the buffered window it would occupy', async () => {
    const result = await caller().spaces.availability(window);
    expect(result.available).toBe(true);
    expect(result.buffered.startsAt.toISOString()).toBe('2026-10-01T14:30:00.000Z');
    expect(result.buffered.endsAt.toISOString()).toBe('2026-10-01T21:00:00.000Z');
  });

  it('reports the booking in the way, buffers included', async () => {
    mocks.bookingFindMany.mockResolvedValue([
      {
        id: 'booking_walima',
        kind: 'FUNCTION',
        startsAt: new Date('2026-10-01T12:00:00.000Z'),
        endsAt: new Date('2026-10-01T16:00:00.000Z'),
      },
    ]);
    const result = await caller().spaces.availability(window);
    expect(result.available).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.id)).toEqual(['booking_walima']);
  });

  it('refuses a window that does not end after it starts', async () => {
    await expect(
      caller().spaces.availability({ ...window, endsAt: window.startsAt })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('says who creates a property rather than failing blankly when there is none', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(caller().spaces.list()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller().spaces.create(validSpaceInput)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('hotelProperty.spaces ID isolation across properties', () => {
  let rows: (typeof storedSpace)[];

  beforeEach(() => {
    // Two properties belong to this organization. The existing resolver chooses
    // the first active property; branch selection itself remains a separate gate.
    const properties = [
      property,
      { ...property, branchId: 'branch_2', createdAt: new Date('2026-09-09T00:00:00.000Z') },
      { ...property, branchId: 'branch_other_org', organizationId: 'org_other' },
    ];
    rows = [
      { ...storedSpace },
      { ...storedSpace, id: 'space_other_property', branchId: 'branch_2' },
      { ...storedSpace, id: 'space_other_organization', organizationId: 'org_other' },
    ];
    const matches = (row: object, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value);
    mocks.findFirst.mockImplementation(
      async ({ where }) => properties.find((row) => matches(row, where)) ?? null
    );
    mocks.spaceFindFirst.mockImplementation(
      async ({ where }) => rows.find((row) => matches(row, where)) ?? null
    );
    mocks.spaceUpdateMany.mockImplementation(async ({ where, data }) => {
      const matched = rows.filter((row) => matches(row, where));
      matched.forEach((row) => Object.assign(row, data));
      return { count: matched.length };
    });
  });

  const cases = [
    ['same property', 'space_crystal', true],
    ['another property in the same organization', 'space_other_property', false],
    ['another organization', 'space_other_organization', false],
  ] as const;
  const forgedScope = {
    organizationId: 'org_other',
    branchId: 'branch_2',
    propertyId: 'branch_2',
  };

  it.each(cases)('update uses trusted scope for %s', async (_label, id, allowed) => {
    const before = structuredClone(rows);
    const result = caller().spaces.update({
      ...validSpaceInput,
      ...forgedScope,
      id,
      name: 'Updated Hall',
    });
    if (allowed) await expect(result).resolves.toEqual({ id });
    else await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(rows).toEqual(
      before.map((row) =>
        allowed && row.id === id ? { ...row, ...validSpaceInput, name: 'Updated Hall' } : row
      )
    );
    expect(mocks.spaceUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: property.branchId, id } })
    );
  });

  it.each(cases)('retirement uses trusted scope for %s', async (_label, id, allowed) => {
    const before = structuredClone(rows);
    const result = caller().spaces.deactivate({ ...forgedScope, spaceId: id });
    if (allowed) await expect(result).resolves.toEqual({ id, active: false });
    else await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(rows).toEqual(
      before.map((row) => (allowed && row.id === id ? { ...row, active: false } : row))
    );
    expect(mocks.spaceUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: property.branchId, id },
      data: { active: false },
    });
  });

  it.each(cases)('availability uses trusted scope for %s', async (_label, id, allowed) => {
    const result = caller().spaces.availability({ ...window, ...forgedScope, spaceId: id });
    if (allowed) {
      await expect(result).resolves.toMatchObject({ spaceId: id, available: true, conflicts: [] });
      expect(mocks.bookingFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORG,
            branchId: property.branchId,
            spaceId: id,
          }),
        })
      );
    } else {
      await expect(result).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mocks.bookingFindMany).not.toHaveBeenCalled();
    }
    expect(mocks.spaceFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: property.branchId, id } })
    );
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, active: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('only discloses conflicts within the resolved organization, property and space', async () => {
    const booking = {
      id: 'booking_current',
      organizationId: ORG,
      branchId: property.branchId,
      spaceId: storedSpace.id,
      kind: 'FUNCTION',
      startsAt: new Date('2026-10-01T12:00:00.000Z'),
      endsAt: new Date('2026-10-01T16:00:00.000Z'),
    };
    const bookings = [
      booking,
      { ...booking, id: 'booking_other_property', branchId: 'branch_2' },
      { ...booking, id: 'booking_other_organization', organizationId: 'org_other' },
      { ...booking, id: 'booking_other_space', spaceId: 'space_other_property' },
    ];
    mocks.bookingFindMany.mockImplementation(async ({ where }) =>
      bookings.filter((row) =>
        ['organizationId', 'branchId', 'spaceId'].every(
          (key) => !(key in where) || row[key as keyof typeof row] === where[key]
        )
      )
    );
    const result = await caller().spaces.availability(window);
    expect(result.available).toBe(false);
    expect(result.conflicts.map((conflict) => conflict.id)).toEqual([booking.id]);
  });
});
