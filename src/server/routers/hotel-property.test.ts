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
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  findFirst: vi.fn(),
  updateMany: vi.fn(async () => ({ count: 1 })),
  count: vi.fn(async () => 15),
  roomTypeCount: vi.fn(async () => 0),
  queryRaw: vi.fn(async () => []),
  inventoryList: vi.fn(async () => []),
  inventoryFind: vi.fn(async () => ({ id: 'room_1' })),
  inventoryCreate: vi.fn(async () => ({ id: 'type_1' })),
  roomTypeFind: vi.fn(),
  roomCreate: vi.fn(async () => ({ id: 'room_1' })),
  roomResult: vi.fn(async () => ({ id: 'room_1', beds: [] })),
  bedCreateMany: vi.fn(async () => ({ count: 2 })),
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

import type { TRPCContext } from '../trpc';
import { hotelPackageEntitlements } from '@/lib/hotel/features';
import type { EntitlementSnapshot } from '@/lib/module-catalog';
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

function caller(
  entitlements: EntitlementSnapshot = { enabledModules: ['hotel-core'], limits: {} }
) {
  return hotelPropertyRouter.createCaller({
    db: {
      $transaction: async (run: (db: unknown) => unknown) =>
        run({
          $queryRaw: mocks.queryRaw,
          hotelRoomType: {
            count: mocks.roomTypeCount,
            findMany: mocks.inventoryList,
            create: mocks.inventoryCreate,
            findFirst: mocks.roomTypeFind,
          },
          hotelRoom: {
            findMany: mocks.inventoryList,
            findFirst: mocks.inventoryFind,
            create: mocks.roomCreate,
            findFirstOrThrow: mocks.roomResult,
          },
          hotelBed: { findMany: mocks.inventoryList, createMany: mocks.bedCreateMany },
          hotelRoomStatusEvent: { findMany: mocks.inventoryList },
          hotelRoomBlock: { findMany: mocks.inventoryList, create: mocks.inventoryCreate },
        }),
      hotelProperty: { findFirst: mocks.findFirst, updateMany: mocks.updateMany },
      organizationRole: { count: mocks.count },
    },
    entitlements: { organizationId: ORG, ...entitlements },
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
    ['get', () => caller().get()],
    ['modes.get', () => caller().modes.get()],
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
    await expect(caller().modes.set({ mode: 'VENUE' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
});

describe('hotelProperty with property administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findFirst.mockResolvedValue(property);
    mocks.count.mockResolvedValue(15);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  it('returns the property, the named mode choices and the checklist', async () => {
    const result = await caller().get();
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
      expect.objectContaining({ where: { organizationId: ORG, active: true } })
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
    await expect(caller().modes.set({ mode: 'HOSTEL' })).resolves.toEqual({ mode: 'HOSTEL' });
    expect(mocks.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: 'branch_1' },
        data: { mode: 'HOSTEL' },
      })
    );
  });

  it('refuses a mode outside the closed set', async () => {
    await expect(
      caller().modes.set({ mode: 'MOTEL' } as unknown as { mode: 'HOTEL' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it('says who creates a property rather than failing blankly when there is none', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(caller().modes.get()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller().update(validUpdate)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // The read still answers, so the settings page can explain itself.
    const result = await caller().get();
    expect(result.property).toBeNull();
    expect(result.checklist.ready).toBe(false);
  });
});

describe('hotelProperty inventory contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findFirst.mockResolvedValue(property);
    mocks.inventoryCreate.mockResolvedValue({ id: 'type_1' });
  });

  it.each([
    ['roomTypes.list', () => caller().roomTypes.list()],
    ['rooms.list', () => caller().rooms.list()],
    ['rooms.history', () => caller().rooms.history({ roomId: 'room_1' })],
    ['beds.list', () => caller().beds.list({ roomId: 'room_1' })],
    ['blocks.list', () => caller().blocks.list({ roomId: 'room_1' })],
    [
      'roomTypes.create',
      () =>
        caller().roomTypes.create({
          code: 'STD',
          name: 'Standard',
          inventoryKind: 'ROOM',
          baseAdults: 1,
          maxAdults: 2,
          maxChildren: 0,
        }),
    ],
    [
      'rooms.create',
      () => caller().rooms.create({ roomTypeId: 'type_1', number: '101', reason: 'Commissioned' }),
    ],
    [
      'rooms.setStatus',
      () =>
        caller().rooms.setStatus({
          id: 'room_1',
          expectedStatus: 'VACANT_DIRTY',
          status: 'VACANT_CLEAN',
          reason: 'Cleaned',
        }),
    ],
    [
      'beds.setStatus',
      () =>
        caller().beds.setStatus({
          id: 'bed_1',
          expectedStatus: 'VACANT_DIRTY',
          status: 'VACANT_CLEAN',
          reason: 'Cleaned',
        }),
    ],
    [
      'blocks.create',
      () =>
        caller().blocks.create({
          roomId: 'room_1',
          kind: 'OUT_OF_ORDER',
          startDate: '2026-09-12',
          endDate: '2026-09-13',
          reason: 'Repair',
        }),
    ],
    ['blocks.release', () => caller().blocks.release({ id: 'block_1', reason: 'Repair complete' })],
  ])('gates %s before inventory access', async (_name, run) => {
    mocks.can.mockResolvedValue(false);
    await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'hotel:property-admin',
      undefined,
      expect.anything()
    );
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('derives tenant and property from server context on inventory reads', async () => {
    await caller().rooms.list();
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, active: true } })
    );
    expect(mocks.inventoryList).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: 'branch_1' } })
    );
    expect(mocks.queryRaw.mock.calls[0].slice(1)).toEqual(['branch_1', 'front-desk-user', '']);
  });

  it('creates UNIT types with server scope and maps duplicate identifiers to CONFLICT', async () => {
    const input = {
      code: 'APT',
      name: 'Apartment',
      inventoryKind: 'UNIT' as const,
      baseAdults: 1,
      maxAdults: 2,
      maxChildren: 0,
    };
    await expect(caller().roomTypes.create(input)).resolves.toEqual({ id: 'type_1' });
    expect(mocks.inventoryCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: ORG,
        branchId: 'branch_1',
        inventoryKind: 'UNIT',
      }),
    });
    mocks.inventoryCreate.mockRejectedValueOnce({ code: 'P2002' });
    await expect(caller().roomTypes.create(input)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects missing property before opening inventory transaction', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(caller().roomTypes.list()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied branch and OCCUPIED status', async () => {
    const input = {
      id: 'room_1',
      expectedStatus: 'VACANT_DIRTY' as const,
      status: 'VACANT_CLEAN' as const,
      reason: 'Cleaned',
    };
    await expect(
      caller().rooms.setStatus({ ...input, branchId: 'sibling' } as typeof input)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller().rooms.setStatus({ ...input, status: 'OCCUPIED' } as unknown as typeof input)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });
});

describe('hotelProperty room-create entitlements', () => {
  const input = { roomTypeId: 'type_1', number: 'V-101', reason: 'Commissioned' };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.findFirst.mockResolvedValue(property);
    mocks.roomTypeFind.mockResolvedValue({ id: 'type_1', inventoryKind: 'ROOM' });
  });

  it.each([
    ['Venue package', hotelPackageEntitlements('hotel-venue')],
    [
      'explicit zero override',
      hotelPackageEntitlements('hotel-essentials', { limits: { 'hotel.rooms.max': 0 } }),
    ],
    ['missing room limit', { enabledModules: ['hotel-core'], limits: {} }],
    ['missing core module', { enabledModules: [], limits: { 'hotel.rooms.max': 1 } }],
  ])('denies %s before room or bed insertion', async (_label, entitlements) => {
    await expect(caller(entitlements).rooms.create(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Room creation is disabled by workspace entitlements.',
    });
    expect(mocks.roomCreate).not.toHaveBeenCalled();
    expect(mocks.bedCreateMany).not.toHaveBeenCalled();
  });

  it.each(['ROOM', 'BED', 'UNIT'] as const)(
    'allows granted %s inventory with server-derived scope and actor',
    async (inventoryKind) => {
      mocks.roomTypeFind.mockResolvedValue({ id: 'type_1', inventoryKind, bedsPerRoom: 2 });
      await expect(
        caller(hotelPackageEntitlements('hotel-essentials')).rooms.create(input)
      ).resolves.toEqual({ id: 'room_1', beds: [] });
      expect(mocks.roomTypeFind).toHaveBeenCalledWith({
        where: { organizationId: ORG, branchId: 'branch_1', id: 'type_1' },
      });
      expect(mocks.roomCreate).toHaveBeenCalledExactlyOnceWith({
        data: expect.objectContaining({
          organizationId: ORG,
          branchId: 'branch_1',
          roomTypeId: 'type_1',
          number: 'V-101',
          statusChangedBy: 'front-desk-user',
        }),
      });
      if (inventoryKind === 'BED') {
        expect(mocks.bedCreateMany).toHaveBeenCalledWith({
          data: ['1', '2'].map((label) => ({
            organizationId: ORG,
            branchId: 'branch_1',
            roomId: 'room_1',
            label,
            statusChangedBy: 'front-desk-user',
          })),
        });
      } else {
        expect(mocks.bedCreateMany).not.toHaveBeenCalled();
      }
    }
  );

  it('honors an explicit room grant for a VENUE property and package', async () => {
    mocks.findFirst.mockResolvedValue({ ...property, mode: 'VENUE' });
    const entitlements = hotelPackageEntitlements('hotel-venue', {
      limits: { 'hotel.rooms.max': 1 },
    });
    await expect(caller(entitlements).rooms.create(input)).resolves.toEqual({
      id: 'room_1',
      beds: [],
    });
    expect(mocks.roomCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps zero-room Venue property administration available while denying room creation', async () => {
    mocks.findFirst.mockResolvedValue({ ...property, mode: 'VENUE' });
    const venue = caller(hotelPackageEntitlements('hotel-venue'));
    await expect(venue.get()).resolves.toMatchObject({ property: { mode: 'VENUE' } });
    await venue.update(validUpdate);
    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    await expect(venue.rooms.create(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.roomCreate).not.toHaveBeenCalled();
    expect(mocks.bedCreateMany).not.toHaveBeenCalled();
  });
});

it('returns CONFLICT for the verified PostgreSQL exclusion error shape', async () => {
  mocks.can.mockResolvedValue(true);
  mocks.findFirst.mockResolvedValue(property);
  mocks.inventoryCreate.mockRejectedValueOnce({
    code: 'P2039',
    meta: { driverAdapterError: { cause: { originalCode: '23P01' } } },
  });
  await expect(
    caller().blocks.create({
      roomId: 'room_1',
      kind: 'OUT_OF_ORDER',
      startDate: '2026-09-12',
      endDate: '2026-09-13',
      reason: 'Repair',
    })
  ).rejects.toMatchObject({ code: 'CONFLICT', message: 'Room block overlaps an existing block.' });
});
