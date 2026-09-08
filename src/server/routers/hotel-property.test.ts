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

function caller() {
  return hotelPropertyRouter.createCaller({
    db: {
      hotelProperty: { findFirst: mocks.findFirst, updateMany: mocks.updateMany },
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
