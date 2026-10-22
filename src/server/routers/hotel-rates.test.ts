/**
 * MEAL-01 — `hotelRates.mealPlans.*`: its capability gate and its write scoping.
 *
 * Three things are pinned:
 *
 * - every procedure asks the ABAC engine for `hotel:rates`, reads included, and
 *   refuses without it — so a front-desk or housekeeping user cannot change what
 *   a room is sold with;
 * - every write is scoped by `(organizationId, branchId, id)` and the branch is
 *   resolved from the workspace's own property, never taken from the request; and
 * - the plan document is validated before the database is touched, so a plan the
 *   entitlement generator could not read never reaches a row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => false),
  propertyFindFirst: vi.fn(),
  planFindMany: vi.fn(),
  planFindFirst: vi.fn(),
  planCreate: vi.fn(),
  planUpdateMany: vi.fn(),
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
import { hotelRatesRouter } from './hotel-rates';

const ORG = 'org_hotel_rates';
const BRANCH = 'branch_1';

const cp = {
  id: 'plan_cp',
  code: 'CP',
  name: 'Bed & breakfast',
  nameUr: 'کمرہ اور ناشتہ',
  meals: [{ meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true }],
  active: true,
};

const validCreate = {
  code: 'HB-TERRACE',
  name: 'Half board on the terrace',
  nameUr: 'چھت پر ناشتہ اور رات کا کھانا',
  meals: [
    { meal: 'BREAKFAST' as const, outlets: ['outlet_terrace'], cutoff_time: '10:30', per_person: true },
    { meal: 'DINNER' as const, outlets: [], cutoff_time: null, per_person: false },
  ],
  active: true,
};

function caller() {
  return hotelRatesRouter.createCaller({
    db: {
      hotelProperty: { findFirst: mocks.propertyFindFirst },
      hotelMealPlan: {
        findMany: mocks.planFindMany,
        findFirst: mocks.planFindFirst,
        create: mocks.planCreate,
        updateMany: mocks.planUpdateMany,
      },
    },
    entitlements: { organizationId: ORG, enabledModules: ['hotel-core'] },
    session: {
      expires: 'later',
      user: { id: 'revenue-manager', role: 'EMPLOYEE', status: 'ACTIVE' },
    },
    organization: null,
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}

describe('hotelRates.mealPlans capability gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(false);
    mocks.propertyFindFirst.mockResolvedValue({ branchId: BRANCH });
  });

  it.each([
    ['list', () => caller().mealPlans.list()],
    ['create', () => caller().mealPlans.create(validCreate)],
    ['update', () => caller().mealPlans.update({ ...cp, meals: [], active: false })],
    ['setActive', () => caller().mealPlans.setActive({ id: cp.id, active: false })],
  ])('refuses %s without hotel:rates, and touches nothing', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.can).toHaveBeenCalledWith(
      expect.anything(),
      'hotel:rates',
      undefined,
      expect.anything()
    );
    expect(mocks.propertyFindFirst).not.toHaveBeenCalled();
    expect(mocks.planCreate).not.toHaveBeenCalled();
    expect(mocks.planUpdateMany).not.toHaveBeenCalled();
  });
});

describe('hotelRates.mealPlans with rate administration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.can.mockResolvedValue(true);
    mocks.propertyFindFirst.mockResolvedValue({ branchId: BRANCH });
    mocks.planFindMany.mockResolvedValue([cp]);
    mocks.planFindFirst.mockResolvedValue(null);
    mocks.planCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'plan_new',
      ...data,
    }));
    mocks.planUpdateMany.mockResolvedValue({ count: 1 });
  });

  it('lists every plan of this property, inactive ones included', async () => {
    const result = await caller().mealPlans.list();
    expect(mocks.planFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: BRANCH } })
    );
    // The stored document comes back parsed, in the shape the generator reads.
    expect(result.plans[0]!.meals).toEqual([
      { meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true },
    ]);
  });

  it('creates against the workspace’s own property and normalizes the document', async () => {
    const result = await caller().mealPlans.create({
      ...validCreate,
      code: 'hb-terrace',
      // Written out of serving order on purpose: the contract sorts it.
      meals: [validCreate.meals[1]!, validCreate.meals[0]!],
    });

    expect(mocks.planCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ organizationId: ORG, branchId: BRANCH, code: 'HB-TERRACE' }),
      })
    );
    expect(result.plan.meals.map((entry) => entry.meal)).toEqual(['BREAKFAST', 'DINNER']);
  });

  it('refuses a second plan under a code the property already sells', async () => {
    mocks.planFindFirst.mockResolvedValue({ id: cp.id });
    await expect(caller().mealPlans.create({ ...validCreate, code: 'CP' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown service', [{ meal: 'BRUNCH', outlets: [], cutoff_time: null, per_person: true }]],
    [
      'the same service twice',
      [
        { meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true },
        { meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: false },
      ],
    ],
    [
      'a cut-off no clock shows',
      [{ meal: 'LUNCH', outlets: [], cutoff_time: '2pm', per_person: true }],
    ],
  ])('refuses a plan document with %s before touching the database', async (_label, meals) => {
    await expect(
      caller().mealPlans.create({ ...validCreate, meals } as typeof validCreate)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });

  it('refuses a code no voucher could print', async () => {
    for (const code of ['', 'a plan', '-CP']) {
      await expect(caller().mealPlans.create({ ...validCreate, code })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });

  it('scopes an update by organization, branch and id — never by the id alone', async () => {
    mocks.planFindFirst.mockResolvedValue({ ...cp, name: 'Bed, breakfast and a view' });
    await caller().mealPlans.update({
      id: cp.id,
      name: 'Bed, breakfast and a view',
      nameUr: null,
      meals: cp.meals as typeof validCreate.meals,
      active: true,
    });

    expect(mocks.planUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG, branchId: BRANCH, id: cp.id },
        data: expect.objectContaining({ name: 'Bed, breakfast and a view', nameUr: null }),
      })
    );
  });

  it('reports another tenant’s plan id as missing rather than writing it', async () => {
    mocks.planUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().mealPlans.setActive({ id: 'plan_of_another_tenant', active: false })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('withdraws a plan from sale rather than deleting it', async () => {
    const result = await caller().mealPlans.setActive({ id: cp.id, active: false });
    expect(result).toEqual({ id: cp.id, active: false });
    expect(mocks.planUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { active: false } })
    );
  });

  it('refuses to work at all in a workspace with no property yet', async () => {
    mocks.propertyFindFirst.mockResolvedValue(null);
    await expect(caller().mealPlans.list()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(caller().mealPlans.create(validCreate)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(mocks.planCreate).not.toHaveBeenCalled();
  });
});
