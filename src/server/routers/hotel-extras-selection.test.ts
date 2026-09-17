import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: (view: { enabledModules: string[] }, key: string) => view.enabledModules.includes(key),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: () => null,
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));

import type { TRPCContext } from '@/server/trpc';
import { hotelPropertyRouter } from './hotel-property';

const ORG = 'org_a';
const BRANCH = 'property_a';
const allow = { capability: 'hotel:property-admin', effect: 'ALLOW' };
const extra = {
  code: 'TEA',
  name: 'Tea',
  priceMinor: 500,
  taxClass: 'SERVICES',
  department: 'MISCELLANEOUS' as const,
};
const facts = {
  name: 'Selected A',
  addressLine: '1 Main Street',
  city: 'Lahore',
  timezone: 'Asia/Karachi',
  checkInTime: '14:00',
  checkOutTime: '12:00',
  auditTime: '03:00',
  currency: 'PKR',
  languages: ['en'],
  bookingEngineSlug: 'selected-a',
};

function fixture() {
  const state = {
    active: true,
    propertyActive: true,
    organizationId: ORG,
    global: [allow],
    role: [allow],
  };
  const property = {
    ...facts,
    branchId: BRANCH,
    organizationId: ORG,
    active: true,
    mode: 'HOTEL',
    taxProfileId: null,
    businessDatePolicy: {},
  };
  const db = {
    user: {
      findUnique: vi.fn(async () => ({
        organizationRole: { permissions: state.global },
        permissionOverrides: [],
      })),
    },
    hotelPropertyAssignment: {
      findMany: vi.fn(async () => [{ branchId: BRANCH }, { branchId: 'property_b' }]),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            organizationId: string;
            branchId: string;
            userId: string;
            active: boolean;
            property: { organizationId: string; active: boolean };
          };
        }) => {
          if (
            where.organizationId !== state.organizationId ||
            where.branchId !== BRANCH ||
            where.userId !== 'staff_a' ||
            where.active !== state.active ||
            where.property.active !== state.propertyActive ||
            where.property.organizationId !== state.organizationId
          )
            return null;
          return {
            property: { branchId: BRANCH, organizationId: ORG, name: 'Selected A' },
            role: { permissions: state.role },
          };
        }
      ),
    },
    hotelProperty: {
      findFirst: vi.fn(async () => property),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    organizationRole: { count: vi.fn(async () => 15) },
    hotelExtra: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: unknown }) => ({
        id: 'extra_a',
        ...(data as object),
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    // `modes.set` locks the property inside a tenant transaction; the stub runs
    // the callback against itself so the resolver under test is the real one.
    $queryRaw: vi.fn(async () => [{ branchId: BRANCH }]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (run: (client: typeof db) => Promise<unknown>) =>
    run(db)
  );
  const ctx = {
    db,
    // `limits` is not optional on the real entitlement view, and the feature
    // evaluation `modes.get` performs indexes into it.
    entitlements: { organizationId: ORG, enabledModules: ['hotel-core'], limits: {} },
    session: {
      expires: 'later',
      user: { id: 'staff_a', organizationId: ORG, role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { state, db, ctx, caller: hotelPropertyRouter.createCaller(ctx) };
}
type Caller = ReturnType<typeof fixture>['caller'];
const operations: [string, (caller: Caller, branchId: string) => Promise<unknown>][] = [
  ['get', (c, branchId) => c.get({ branchId })],
  ['update', (c, branchId) => c.update({ ...facts, branchId })],
  ['modes.get', (c, branchId) => c.modes.get({ branchId })],
  ['modes.set', (c, branchId) => c.modes.set({ branchId, mode: 'HOSTEL' })],
  [
    'extras.list',
    (c, branchId) => c.extras.list({ branchId, includeInactive: false, upsellableOnly: false }),
  ],
  ['extras.create', (c, branchId) => c.extras.create({ ...extra, branchId })],
  ['extras.update', (c, branchId) => c.extras.update({ ...extra, branchId, id: 'extra_a' })],
  [
    'extras.setActive',
    (c, branchId) => c.extras.setActive({ branchId, id: 'extra_a', active: false }),
  ],
];

beforeEach(() => vi.clearAllMocks());

describe('selected property consumers', () => {
  it.each(operations)(
    '%s resolves the explicit branch using fresh membership',
    async (_name, invoke) => {
      const f = fixture();
      await invoke(f.caller, BRANCH);
      expect(f.db.hotelPropertyAssignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORG,
            branchId: BRANCH,
            userId: 'staff_a',
            active: true,
          }),
        })
      );
      // Every operation must reach the *selected* property, scoped by
      // `(organizationId, branchId, active)` and never by an oldest-property
      // fallback. `modes.set` reaches it through the locked write inside its own
      // tenant transaction rather than through a read, so for that one the
      // scoped `where` is on `updateMany` — and the read must not happen at all.
      const scoped = { where: { organizationId: ORG, branchId: BRANCH, active: true } };
      if (_name === 'modes.set') {
        expect(f.db.$queryRaw).toHaveBeenCalled();
        expect(f.db.hotelProperty.updateMany).toHaveBeenCalledWith(expect.objectContaining(scoped));
        expect(f.db.hotelProperty.findFirst).not.toHaveBeenCalled();
      } else {
        expect(f.db.hotelProperty.findFirst).toHaveBeenCalledWith(scoped);
      }
    }
  );

  it.each(operations)(
    '%s denies unassigned same-organization B before property/catalog access',
    async (_name, invoke) => {
      const f = fixture();
      await expect(invoke(f.caller, 'property_b')).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.hotelProperty.findFirst).not.toHaveBeenCalled();
      expect(f.db.hotelProperty.updateMany).not.toHaveBeenCalled();
      for (const call of Object.values(f.db.hotelExtra)) expect(call).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['revoked assignment', { active: false }],
    ['inactive property', { propertyActive: false }],
    ['foreign assignment', { organizationId: 'foreign_org' }],
    ['property capability DENY', { role: [allow, { ...allow, effect: 'DENY' }] }],
    ['global capability DENY', { global: [allow, { ...allow, effect: 'DENY' }] }],
  ])('a previously selected catalog denies %s on the next read and write', async (_name, patch) => {
    const f = fixture();
    await f.caller.extras.list({ branchId: BRANCH });
    Object.assign(f.state, patch);
    f.db.hotelExtra.findMany.mockClear();
    await expect(f.caller.extras.list({ branchId: BRANCH })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(f.caller.extras.create({ branchId: BRANCH, ...extra })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.hotelExtra.findMany).not.toHaveBeenCalled();
    expect(f.db.hotelExtra.create).not.toHaveBeenCalled();
  });

  it('preserves module licensing independently of assignment and capabilities', async () => {
    const f = fixture();
    f.ctx.entitlements.enabledModules = [];
    await expect(f.caller.extras.list({ branchId: BRANCH })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.hotelExtra.findMany).not.toHaveBeenCalled();
  });

  it('rejects mismatched tenant identity before discovery', async () => {
    const f = fixture();
    f.ctx.session!.user.organizationId = 'foreign_org';
    await expect(f.caller.extras.properties()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.db.hotelPropertyAssignment.findMany).not.toHaveBeenCalled();
  });

  it('missing selection fails closed across legacy property and Extras entrypoints', async () => {
    const f = fixture();
    for (const operation of [
      () => f.caller.get(),
      () => f.caller.update(facts),
      () => f.caller.modes.get(),
      () => f.caller.modes.set({ mode: 'HOTEL' }),
    ]) {
      await expect(operation()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    }
    await expect(f.caller.extras.list({ branchId: '' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.db.hotelProperty.findFirst).not.toHaveBeenCalled();
  });

  it('computes readiness from the selected property without an oldest-property lookup', async () => {
    const f = fixture();
    const result = await f.caller.get({ branchId: BRANCH });
    expect(result.property.branchId).toBe(BRANCH);
    expect(result.checklist.blocking.map((item) => item.key)).toEqual([
      'TAX_PROFILE',
      'BUSINESS_DATE_AND_AUDIT',
      'ROOM_TYPES',
    ]);
    expect(f.db.hotelProperty.findFirst).toHaveBeenCalledTimes(1);
    expect(f.db.hotelProperty.findFirst.mock.calls[0]).toEqual([
      { where: { organizationId: ORG, branchId: BRANCH, active: true } },
    ]);
  });

  it('scopes all catalog writes and duplicate reads to the selected tenant/property', async () => {
    const f = fixture();
    await f.caller.extras.create({ branchId: BRANCH, ...extra });
    await f.caller.extras.update({ branchId: BRANCH, ...extra, id: 'extra_a' });
    await f.caller.extras.setActive({ branchId: BRANCH, id: 'extra_a', active: false });
    expect(f.db.hotelExtra.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: ORG, branchId: BRANCH }),
    });
    for (const call of f.db.hotelExtra.updateMany.mock.calls)
      expect(call).toEqual([
        {
          where: { organizationId: ORG, branchId: BRANCH, id: 'extra_a' },
          data: expect.any(Object),
        },
      ]);
    expect(f.db.hotelExtra.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, code: 'TEA' },
      select: { id: true, name: true },
    });
  });

  it('discovery returns only effectively authorized choices, bound to this identity', async () => {
    const f = fixture();
    await expect(f.caller.extras.properties()).resolves.toEqual({
      organizationId: ORG,
      userId: 'staff_a',
      properties: [{ branchId: BRANCH, name: 'Selected A' }],
    });
    expect(f.db.hotelPropertyAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG,
          userId: 'staff_a',
          active: true,
          property: { organizationId: ORG, active: true },
        }),
      })
    );
    f.state.role = [{ ...allow, effect: 'DENY' }];
    await expect(f.caller.extras.properties()).resolves.toMatchObject({ properties: [] });
  });

  it('does not convert a discovery database failure into an empty grant list', async () => {
    const f = fixture();
    f.db.hotelPropertyAssignment.findFirst.mockRejectedValue(new Error('database unavailable'));
    await expect(f.caller.extras.properties()).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    });
  });
});
