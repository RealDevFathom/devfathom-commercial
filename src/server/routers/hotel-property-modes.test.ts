import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ record: vi.fn(), annotate: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => false,
  recordTrpcAudit: audit.record,
  annotateAudit: audit.annotate,
}));

import type { HotelPropertyMode } from '@/generated/prisma/enums';
import { hotelModeOverridesInput, readHotelModeOverrides } from '@/lib/hotel/mode-overrides';
import type { TRPCContext } from '@/server/trpc';
import { hotelPropertyRouter } from './hotel-property';

const ORG = 'hotel_org';
const BRANCH = 'property_a';
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const allow: Rule = { capability: 'hotel:property-admin', effect: 'ALLOW' };
const deny: Rule = { ...allow, effect: 'DENY' };

function fixture() {
  const state = {
    active: true,
    propertyActive: true,
    organizationId: ORG,
    userId: 'manager_a',
    userStatus: 'ACTIVE',
    roleKey: 'general-manager',
    global: [allow],
    role: [allow],
    permissionOverrides: [] as Rule[],
    writeCount: 1,
  };
  const property = {
    branchId: BRANCH,
    organizationId: ORG,
    active: true,
    mode: 'HOTEL' as HotelPropertyMode,
    modeOverrides: null as unknown,
  };
  const events: string[] = [];
  const user = () => ({
    findUnique: vi.fn(async () => ({
      organizationRole: { permissions: state.global },
      permissionOverrides: state.permissionOverrides,
    })),
  });
  const assignment = () => ({
    findFirst: vi.fn(
      async ({
        where,
      }: {
        where: {
          organizationId: string;
          branchId: string;
          userId: string;
          active: boolean;
          user: { organizationId: string; status: { in: string[] } };
          property: { organizationId: string; active: boolean };
          role: { organizationId: string; key: { in: string[] } };
        };
      }) => {
        events.push('resolve');
        if (
          where.organizationId !== state.organizationId ||
          where.branchId !== BRANCH ||
          where.userId !== state.userId ||
          where.active !== state.active ||
          where.user.organizationId !== state.organizationId ||
          !where.user.status.in.includes(state.userStatus) ||
          where.property.organizationId !== state.organizationId ||
          where.property.active !== state.propertyActive ||
          where.role.organizationId !== state.organizationId ||
          !where.role.key.in.includes(state.roleKey)
        )
          return null;
        return {
          property: { organizationId: ORG, branchId: BRANCH, name: 'Selected A' },
          role: { permissions: state.role },
        };
      }
    ),
  });
  const tx = {
    user: user(),
    hotelPropertyAssignment: assignment(),
    $queryRaw: vi.fn<
      (sql: TemplateStringsArray, ...values: unknown[]) => Promise<{ branchId: string }[]>
    >(async () => {
      events.push('lock');
      return [{ branchId: BRANCH }];
    }),
    hotelProperty: {
      updateMany: vi.fn(
        async ({ data }: { data: { mode: HotelPropertyMode; modeOverrides?: unknown } }) => {
          events.push('write');
          if (state.writeCount === 1) Object.assign(property, data);
          return { count: state.writeCount };
        }
      ),
    },
  };
  const db = {
    user: user(),
    hotelPropertyAssignment: assignment(),
    hotelProperty: {
      findFirst: vi.fn(async () => {
        events.push('read');
        return property;
      }),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => {
      events.push('transaction');
      const before = { ...property };
      try {
        const result = await run(tx);
        events.push('commit');
        return result;
      } catch (error) {
        Object.assign(property, before);
        events.push('rollback');
        throw error;
      }
    }),
  };
  const ctx = {
    db,
    entitlements: {
      organizationId: ORG,
      enabledModules: ['hotel-core', 'hotel-reservations', 'hotel-front-desk', 'hotel-banquets'],
      modules: [],
      limits: { 'hotel.rooms.max': 25 },
    },
    session: {
      expires: 'later',
      user: { id: 'manager_a', organizationId: ORG, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  audit.annotate.mockImplementation(() => {
    events.push('annotate');
  });
  audit.record.mockImplementation(() => {
    events.push('audit');
  });
  return { state, property, db, tx, ctx, events, caller: hotelPropertyRouter.createCaller(ctx) };
}

beforeEach(() => vi.clearAllMocks());

describe('strict explicit mode override storage', () => {
  it.each([
    null,
    [],
    'HOTEL',
    0,
    false,
    NaN,
    Infinity,
    { unknown: true },
    { capabilities: ['hotel:property-admin'] },
    { inventoryKinds: ['SUITE'] },
    { inventoryKinds: 'ROOM' },
    { inventoryKinds: [null] },
    { billingCycles: ['DAILY'] },
    { billingCycles: null },
    { dayUse: 'false' },
    { dayUse: 0 },
    { dayUse: null },
    { dayUse: Infinity },
    { functionSpaces: {} },
    { dormPolicies: NaN },
    { recurringExtras: [] },
    { tenancyDocuments: 1 },
    { bookingEngineLayout: 'VENUE' },
    { reportKeys: [1] },
    { reportKeys: { name: 'day-use' } },
  ])('rejects invalid shape/value %j', (value) => {
    expect(hotelModeOverridesInput.safeParse(value).success).toBe(false);
  });

  it('accepts only helper vocabulary and preserves false/empty decisions', () => {
    const value = {
      inventoryKinds: [],
      billingCycles: [],
      dayUse: false,
      functionSpaces: false,
      dormPolicies: false,
      recurringExtras: false,
      tenancyDocuments: false,
      bookingEngineLayout: 'FUNCTIONS',
      reportKeys: [],
    };
    expect(hotelModeOverridesInput.parse(value)).toEqual(value);
  });

  it('normalizes undefined members to absence without mutating input', () => {
    const value = { dayUse: undefined, reportKeys: [] };
    expect(hotelModeOverridesInput.parse(value)).toEqual({ reportKeys: [] });
    expect(Object.hasOwn(value, 'dayUse')).toBe(true);
  });

  it.each([null, undefined])('reads absent legacy storage %j as no overrides', (value) => {
    expect(readHotelModeOverrides(value)).toEqual({});
  });

  it.each([[], { dayUse: null }, { unknown: true }])(
    'rejects malformed stored JSON %j',
    (value) => {
      expect(() => readHotelModeOverrides(value)).toThrow();
    }
  );
});

describe('mode persistence callers', () => {
  it('reads defaults and flags on the same scoped client after fresh property authorization', async () => {
    const f = fixture();
    const result = await f.caller.modes.get({ branchId: BRANCH });
    expect(result).toMatchObject({
      mode: 'HOTEL',
      overrides: {},
      configuration: { inventoryKinds: ['ROOM'], dayUse: true, bookingEngineLayout: 'ROOMS' },
      features: { rooms: true, reservations: true, dayUse: true, functionSpaces: false },
    });
    expect(result.options).toHaveLength(5);
    expect(f.events).toEqual(['resolve', 'read', 'audit']);
    expect(f.db.hotelProperty.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, active: true },
    });
    expect(f.db.hotelProperty.updateMany).not.toHaveBeenCalled();
    expect(f.tx.hotelProperty.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['HOTEL', ['ROOM'], 'ROOMS'],
    ['HOSTEL', ['BED'], 'BEDS'],
    ['APARTMENT', ['UNIT'], 'UNITS'],
    ['RESORT', ['ROOM'], 'ROOMS_AND_SLOTS'],
    ['VENUE', [], 'FUNCTIONS'],
  ] as const)(
    'keeps legacy mode-only input/result for %s without storing defaults',
    async (mode, kinds, layout) => {
      const f = fixture();
      await expect(f.caller.modes.set({ branchId: BRANCH, mode })).resolves.toEqual({ mode });
      expect(f.tx.hotelProperty.updateMany).toHaveBeenCalledWith({
        where: { organizationId: ORG, branchId: BRANCH, active: true },
        data: { mode },
      });
      expect(f.property.modeOverrides).toBeNull();
      const result = await f.caller.modes.get({ branchId: BRANCH });
      expect(result.configuration).toMatchObject({
        inventoryKinds: kinds,
        bookingEngineLayout: layout,
      });
    }
  );

  it('preserves explicit false and empty arrays across mode changes', async () => {
    const f = fixture();
    const overrides = { dayUse: false, inventoryKinds: [], reportKeys: [] };
    await f.caller.modes.set({ branchId: BRANCH, mode: 'RESORT', overrides });
    expect(f.property.modeOverrides).toEqual(overrides);
    await f.caller.modes.set({ branchId: BRANCH, mode: 'HOSTEL' });
    expect(f.property.modeOverrides).toEqual(overrides);
    const result = await f.caller.modes.get({ branchId: BRANCH });
    expect(result.overrides).toEqual(overrides);
    expect(result.configuration).toMatchObject({
      ...overrides,
      dormPolicies: true,
      bookingEngineLayout: 'BEDS',
    });
    expect(result.features.rooms).toBe(false);
  });

  it('replaces the full explicit object instead of merging it', async () => {
    const f = fixture();
    f.property.modeOverrides = { inventoryKinds: [], dayUse: false, reportKeys: [] };
    await f.caller.modes.set({
      branchId: BRANCH,
      mode: 'HOTEL',
      overrides: { functionSpaces: true },
    });
    expect(f.property.modeOverrides).toEqual({ functionSpaces: true });
    expect((await f.caller.modes.get({ branchId: BRANCH })).configuration).toMatchObject({
      inventoryKinds: ['ROOM'],
      dayUse: true,
      functionSpaces: true,
      reportKeys: ['occupancy-revenue', 'arrivals-departures', 'day-use'],
    });
  });

  it('persists {} as reset while omitted or undefined overrides preserve storage', async () => {
    const f = fixture();
    f.property.modeOverrides = { dayUse: false };
    await f.caller.modes.set({ branchId: BRANCH, mode: 'RESORT', overrides: undefined });
    expect(f.property.modeOverrides).toEqual({ dayUse: false });
    await f.caller.modes.set({ branchId: BRANCH, mode: 'HOTEL', overrides: {} });
    expect(f.property.modeOverrides).toEqual({});
    expect((await f.caller.modes.get({ branchId: BRANCH })).configuration.dayUse).toBe(true);
  });

  it('uses authoritative entitlement reductions on every read without modifying configuration', async () => {
    const f = fixture();
    f.property.modeOverrides = { functionSpaces: true };
    expect((await f.caller.modes.get({ branchId: BRANCH })).features).toMatchObject({
      rooms: true,
      reservations: true,
      functionSpaces: true,
    });
    f.ctx.entitlements.enabledModules = ['hotel-core'];
    f.ctx.entitlements.limits['hotel.rooms.max'] = 0;
    const reduced = await f.caller.modes.get({ branchId: BRANCH });
    expect(reduced.features).toMatchObject({
      rooms: false,
      reservations: false,
      dayUse: false,
      functionSpaces: false,
    });
    expect(reduced.configuration).toMatchObject({ inventoryKinds: ['ROOM'], functionSpaces: true });
    expect(f.property.modeOverrides).toEqual({ functionSpaces: true });
  });

  it('cannot grant missing modules through overrides or a mode change', async () => {
    const f = fixture();
    f.ctx.entitlements.enabledModules = ['hotel-core'];
    await f.caller.modes.set({
      branchId: BRANCH,
      mode: 'VENUE',
      overrides: {
        inventoryKinds: ['ROOM'],
        billingCycles: ['SLOT', 'NIGHTLY'],
        dayUse: true,
        functionSpaces: true,
      },
    });
    expect((await f.caller.modes.get({ branchId: BRANCH })).features).toMatchObject({
      reservations: false,
      availabilityDays: false,
      frontDesk: false,
      dayUse: false,
      banquets: false,
    });
    expect(f.ctx.entitlements.enabledModules).toEqual(['hotel-core']);
  });

  it('VENUE defaults hide rooms and availability without fabricating availability enforcement', async () => {
    const f = fixture();
    await f.caller.modes.set({ branchId: BRANCH, mode: 'VENUE' });
    expect((await f.caller.modes.get({ branchId: BRANCH })).features).toMatchObject({
      rooms: false,
      availabilityDays: false,
      reservations: false,
      functionSpaces: true,
    });
  });

  it.each([
    { overrides: null },
    { overrides: { unknown: true } },
    { overrides: { dayUse: 'false' } },
    { overrides: { reportKeys: [Infinity] } },
    { mode: 'UNKNOWN' },
    { unknown: true },
  ])('rejects invalid caller input %j before transaction/write', async (patch) => {
    const f = fixture();
    const input = { branchId: BRANCH, mode: 'HOTEL', ...patch };
    await expect(
      f.caller.modes.set(input as Parameters<typeof f.caller.modes.set>[0])
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.tx.hotelProperty.updateMany).not.toHaveBeenCalled();
  });
});

describe('mode authorization, transaction and audit boundaries (mocked DB)', () => {
  it.each(['get', 'set'] as const)(
    'requires explicit property selection for %s',
    async (operation) => {
      const f = fixture();
      const result =
        operation === 'get' ? f.caller.modes.get() : f.caller.modes.set({ mode: 'HOTEL' });
      await expect(result).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(f.db.hotelProperty.findFirst).not.toHaveBeenCalled();
    }
  );

  it.each(['property_b', 'foreign_property'])(
    'denies %s on read and write without fallback',
    async (branchId) => {
      const f = fixture();
      await expect(f.caller.modes.get({ branchId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        f.caller.modes.set({ branchId, mode: 'HOTEL', overrides: {} })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.hotelProperty.findFirst).not.toHaveBeenCalled();
      expect(f.tx.hotelProperty.updateMany).not.toHaveBeenCalled();
      expect(f.property.modeOverrides).toBeNull();
    }
  );

  it.each([
    ['revoked assignment', { active: false }],
    ['inactive property', { propertyActive: false }],
    ['foreign tenant', { organizationId: 'foreign_org' }],
    ['another user', { userId: 'other_user' }],
    ['inactive DB user', { userStatus: 'INACTIVE' }],
    ['unknown role', { roleKey: 'invented-owner' }],
    ['missing role grant', { role: [] }],
    ['role denial', { role: [allow, deny] }],
    ['missing global grant', { global: [] }],
    ['global denial', { permissionOverrides: [deny] }],
  ])('denies %s before read/write', async (_name, patch) => {
    const f = fixture();
    Object.assign(f.state, patch);
    await expect(f.caller.modes.get({ branchId: BRANCH })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(f.caller.modes.set({ branchId: BRANCH, mode: 'VENUE' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.hotelProperty.findFirst).not.toHaveBeenCalled();
    expect(f.tx.hotelProperty.updateMany).not.toHaveBeenCalled();
    expect(audit.annotate).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'modes.set', outcome: 'FAILURE' })
    );
  });

  it.each(['tenant mismatch', 'missing hotel-core', 'ADMIN without assignment'])(
    'preserves %s denial',
    async (reason) => {
      const f = fixture();
      if (reason === 'tenant mismatch') f.ctx.session!.user.organizationId = 'foreign_org';
      if (reason === 'missing hotel-core') f.ctx.entitlements.enabledModules = [];
      if (reason === 'ADMIN without assignment') {
        f.ctx.session!.user.role = 'ADMIN';
        f.state.active = false;
      }
      await expect(f.caller.modes.get({ branchId: BRANCH })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(f.caller.modes.set({ branchId: BRANCH, mode: 'VENUE' })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(f.tx.hotelProperty.updateMany).not.toHaveBeenCalled();
    }
  );

  it('writes through the locked transaction client, then annotates and audits success', async () => {
    const f = fixture();
    await f.caller.modes.set({ branchId: BRANCH, mode: 'HOSTEL', overrides: { dayUse: false } });
    expect(f.events).toEqual([
      'transaction',
      'lock',
      'resolve',
      'write',
      'commit',
      'annotate',
      'audit',
    ]);
    expect(f.tx.$queryRaw.mock.calls[0]?.slice(1)).toEqual([ORG, BRANCH]);
    expect(f.tx.$queryRaw.mock.calls[0]?.[0].join('')).toContain('FOR UPDATE');
    expect(f.db.hotelPropertyAssignment.findFirst).not.toHaveBeenCalled();
    expect(f.db.hotelProperty.updateMany).not.toHaveBeenCalled();
    expect(f.tx.user.findUnique).toHaveBeenCalled();
    expect(audit.annotate).toHaveBeenCalledWith(expect.anything(), {
      targetType: 'HotelProperty',
      targetId: BRANCH,
      description: 'Updated property mode configuration',
      metadata: { branchId: BRANCH, mode: 'HOSTEL', overridesReplaced: true },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'modes.set', type: 'mutation', outcome: 'SUCCESS' })
    );
  });

  it('rechecks revoked membership after the property lock before writing', async () => {
    const f = fixture();
    f.tx.$queryRaw.mockImplementation(async () => {
      f.events.push('lock');
      f.state.active = false;
      return [];
    });
    await expect(f.caller.modes.set({ branchId: BRANCH, mode: 'VENUE' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.events).toEqual(['transaction', 'lock', 'resolve', 'rollback', 'audit']);
    expect(f.tx.hotelProperty.updateMany).not.toHaveBeenCalled();
  });

  it('reports a zero-row update as failure with no success annotation', async () => {
    const f = fixture();
    f.state.writeCount = 0;
    await expect(f.caller.modes.set({ branchId: BRANCH, mode: 'VENUE' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.property.mode).toBe('HOTEL');
    expect(audit.annotate).not.toHaveBeenCalled();
    expect(f.events).toContain('rollback');
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });

  it('propagates a transaction failure without claiming success or persisting partial state', async () => {
    const f = fixture();
    f.tx.hotelProperty.updateMany.mockRejectedValue(new Error('write failed'));
    await expect(
      f.caller.modes.set({ branchId: BRANCH, mode: 'VENUE', overrides: {} })
    ).rejects.toThrow('write failed');
    expect(f.property).toMatchObject({ mode: 'HOTEL', modeOverrides: null });
    expect(f.events).toContain('rollback');
    expect(audit.annotate).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'FAILURE' }));
  });
});
