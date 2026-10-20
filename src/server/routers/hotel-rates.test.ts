/**
 * MEAL-01 — `hotelRates.mealPlans.*`: its capability gate and its write scoping.
 *
 * Pinned here:
 *
 * - every procedure asks the ABAC engine for `hotel:rates` and resolves the
 *   selected property through the scope with `hotel:rates`, reads included — so
 *   a front-desk or housekeeping user cannot change what a room is sold with,
 *   and a denied scope reads and writes nothing;
 * - every write locks the property first, re-checks access, then writes, scoped
 *   by `(organizationId, branchId, id)` and the version the editor saw;
 * - the plan document is validated before the database is touched, a taken code
 *   lands on the `code` field (pre-check and the raced unique violation alike),
 *   and a stale or foreign id is a conflict rather than a silent no-op.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import { Prisma } from '@/generated/prisma/client';

const mocks = vi.hoisted(() => ({ scope: vi.fn(), audit: vi.fn(), capabilities: [] as string[] }));
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
    capabilityProcedure: (action: string) => {
      // Recorded at module load, so it is a list rather than a clearable mock.
      mocks.capabilities.push(action);
      return protectedProcedure;
    },
  };
});
import { hotelRatesRouter } from './hotel-rates';

const ORG = 'org_1';
const BRANCH = 'property_1';
const property = {
  branchId: BRANCH,
  organizationId: ORG,
  name: 'Synthetic',
  mode: 'HOTEL',
  modeOverrides: null,
  active: true,
};
const version = new Date('2026-10-01T10:00:00.000Z');
const cp = {
  id: 'plan_cp',
  code: 'CP',
  name: 'Bed & breakfast',
  nameUr: 'کمرہ اور ناشتہ',
  meals: [{ meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true }],
  active: true,
  updatedAt: version,
};
const validCreate = {
  branchId: BRANCH,
  code: 'HB-TERRACE',
  name: 'Half board on the terrace',
  nameUr: 'چھت پر ناشتہ اور رات کا کھانا',
  meals: [
    {
      meal: 'BREAKFAST' as const,
      outlets: ['outlet_terrace'],
      cutoff_time: '10:30',
      per_person: true,
    },
    { meal: 'DINNER' as const, outlets: [], cutoff_time: null, per_person: false },
  ],
  active: true,
};
const validUpdate = {
  branchId: BRANCH,
  id: cp.id,
  name: 'Bed, breakfast and a view',
  nameUr: null,
  meals: cp.meals as typeof validCreate.meals,
  active: true,
  expectedUpdatedAt: version,
};

const db = {
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  hotelProperty: { findFirst: vi.fn() },
  hotelMealPlan: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
};
const context = (denied = false) => ({
  denied,
  session: { user: { id: 'revenue_manager', organizationId: ORG, role: 'EMPLOYEE' } },
  entitlements: { organizationId: ORG, enabledModules: ['hotel-core'], limits: {} },
  db,
  requestMeta: { ip: null },
  audit: { detail: {} },
});
const caller = (denied = false) =>
  hotelRatesRouter.createCaller(context(denied) as never).mealPlans;
const first = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue(property);
  db.$transaction.mockImplementation(async (run: (value: typeof db) => Promise<unknown>) =>
    run(db)
  );
  db.$queryRaw.mockResolvedValue([{ branchId: BRANCH }]);
  db.hotelProperty.findFirst.mockResolvedValue(property);
  db.hotelMealPlan.findMany.mockResolvedValue([cp]);
  db.hotelMealPlan.findFirst.mockResolvedValue(null);
  db.hotelMealPlan.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'plan_new',
      updatedAt: version,
      ...data,
    })
  );
  db.hotelMealPlan.updateMany.mockResolvedValue({ count: 1 });
});

describe('hotelRates.mealPlans authorization', () => {
  it('declares hotel:rates as the capability of every procedure', () => {
    expect(mocks.capabilities.length).toBeGreaterThan(0);
    expect(new Set(mocks.capabilities)).toEqual(new Set(['hotel:rates']));
  });
  const procedures: Array<[string, () => Promise<unknown>]> = [
    ['list', () => caller().list({ branchId: BRANCH })],
    ['create', () => caller().create(validCreate)],
    ['update', () => caller().update(validUpdate)],
    [
      'setActive',
      () =>
        caller().setActive({
          branchId: BRANCH,
          id: cp.id,
          active: false,
          expectedUpdatedAt: version,
        }),
    ],
  ];
  it.each(procedures)(
    '%s resolves the selected property through the scope with hotel:rates and touches nothing when denied',
    async (_name, run) => {
      mocks.scope.mockRejectedValue(new TRPCError({ code: 'FORBIDDEN' }));
      await expect(run()).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), BRANCH, 'hotel:rates');
      expect(db.hotelMealPlan.findMany).not.toHaveBeenCalled();
      expect(db.hotelMealPlan.create).not.toHaveBeenCalled();
      expect(db.hotelMealPlan.updateMany).not.toHaveBeenCalled();
    }
  );
  it.each(procedures)('%s refuses without the ABAC capability', async (_name, run) => {
    await expect(
      (async () => {
        const denied = caller(true);
        const name = _name as keyof typeof denied;
        return (denied[name] as (input: unknown) => Promise<unknown>)(
          _name === 'list'
            ? { branchId: BRANCH }
            : _name === 'create'
              ? validCreate
              : _name === 'update'
                ? validUpdate
                : { branchId: BRANCH, id: cp.id, active: false, expectedUpdatedAt: version }
        );
      })()
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(db.hotelMealPlan.create).not.toHaveBeenCalled();
    expect(db.hotelMealPlan.updateMany).not.toHaveBeenCalled();
    void run;
  });
  it('refuses a request that names no property before reaching the scope', async () => {
    await expect(caller().list({ branchId: '' } as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.scope).not.toHaveBeenCalled();
  });
  it('locks the property, then re-checks access, then writes', async () => {
    await caller().create(validCreate);
    expect(first(db.$queryRaw)).toBeLessThan(first(mocks.scope)!);
    expect(first(mocks.scope)).toBeLessThan(first(db.hotelMealPlan.create)!);
    expect(db.$queryRaw.mock.calls[0]!.slice(1)).toEqual([ORG, BRANCH]);
  });
});

describe('hotelRates.mealPlans reads', () => {
  it('lists every plan of the selected property, inactive ones included, parsed and labelled', async () => {
    const result = await caller().list({ branchId: BRANCH });
    expect(db.hotelMealPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, branchId: BRANCH } })
    );
    expect(result.plans).toEqual([
      {
        ...cp,
        meals: [{ meal: 'BREAKFAST', outlets: [], cutoff_time: null, per_person: true }],
        standard: true,
      },
    ]);
    expect(result.mealOptions).toEqual([
      { value: 'BREAKFAST', label: 'Breakfast' },
      { value: 'LUNCH', label: 'Lunch' },
      { value: 'DINNER', label: 'Dinner' },
    ]);
    expect(result.standardCodes).toEqual(['EP', 'CP', 'MAP', 'AP']);
  });
});

describe('hotelRates.mealPlans writes', () => {
  it('creates against the selected property and normalizes the document', async () => {
    const result = await caller().create({
      ...validCreate,
      code: 'hb-terrace',
      // Written out of serving order on purpose: the contract sorts it.
      meals: [validCreate.meals[1]!, validCreate.meals[0]!],
    });
    expect(db.hotelMealPlan.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId: ORG,
          branchId: BRANCH,
          code: 'HB-TERRACE',
          name: validCreate.name,
          nameUr: validCreate.nameUr,
          meals: [validCreate.meals[0], validCreate.meals[1]],
          active: true,
        },
      })
    );
    expect(result.plan.meals.map((entry) => entry.meal)).toEqual(['BREAKFAST', 'DINNER']);
    expect(result.plan.standard).toBe(false);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'HotelMealPlan',
        targetId: 'plan_new',
        action: 'hotel.rates.mealPlan.create',
      })
    );
  });
  it('refuses a second plan under a code the property already sells, on the code field', async () => {
    db.hotelMealPlan.findFirst.mockResolvedValue({ id: cp.id });
    const error = await caller()
      .create({ ...validCreate, code: 'CP' })
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['code'] })],
    });
    expect(db.hotelMealPlan.create).not.toHaveBeenCalled();
  });
  it('translates a raced code uniqueness violation into the same code-field error', async () => {
    db.hotelMealPlan.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: '23505',
              originalMessage:
                'duplicate key value violates unique constraint "hotel_meal_plans_org_branch_code_key"',
            },
          },
        },
      })
    );
    const error = await caller()
      .create(validCreate)
      .catch((caught: TRPCError) => caught);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as TRPCError).cause).toMatchObject({
      issues: [expect.objectContaining({ path: ['code'] })],
    });
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
      caller().create({ ...validCreate, meals } as typeof validCreate)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.scope).not.toHaveBeenCalled();
    expect(db.hotelMealPlan.create).not.toHaveBeenCalled();
  });
  it('refuses a code no voucher could print', async () => {
    for (const code of ['', 'a plan', '-CP']) {
      await expect(caller().create({ ...validCreate, code })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    expect(db.hotelMealPlan.create).not.toHaveBeenCalled();
  });
  it('scopes an update by organization, property, id and the version the editor saw', async () => {
    db.hotelMealPlan.findFirst
      .mockResolvedValueOnce(cp)
      .mockResolvedValueOnce({ ...cp, name: validUpdate.name, nameUr: null });
    const result = await caller().update(validUpdate);
    expect(db.hotelMealPlan.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, id: cp.id, updatedAt: version },
      data: {
        name: validUpdate.name,
        nameUr: null,
        meals: cp.meals,
        active: true,
      },
    });
    expect(result.plan.name).toBe(validUpdate.name);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetType: 'HotelMealPlan', targetId: cp.id })
    );
  });
  it('reports a stale version, another tenant’s id and a vanished plan as conflicts without writing', async () => {
    db.hotelMealPlan.findFirst.mockResolvedValue({ ...cp, updatedAt: new Date('2026-10-02') });
    await expect(caller().update(validUpdate)).rejects.toMatchObject({ code: 'CONFLICT' });
    db.hotelMealPlan.findFirst.mockResolvedValue(null);
    await expect(
      caller().update({ ...validUpdate, id: 'plan_of_another_tenant' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.hotelMealPlan.updateMany).not.toHaveBeenCalled();
    db.hotelMealPlan.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      caller().setActive({
        branchId: BRANCH,
        id: 'plan_of_another_tenant',
        active: false,
        expectedUpdatedAt: version,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('withdraws a plan from sale rather than deleting it, and can put it back', async () => {
    const result = await caller().setActive({
      branchId: BRANCH,
      id: cp.id,
      active: false,
      expectedUpdatedAt: version,
    });
    expect(result).toEqual({ id: cp.id, active: false });
    expect(db.hotelMealPlan.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, branchId: BRANCH, id: cp.id, updatedAt: version },
      data: { active: false },
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'hotel.rates.mealPlan.retire' })
    );
    await caller().setActive({
      branchId: BRANCH,
      id: cp.id,
      active: true,
      expectedUpdatedAt: version,
    });
    expect(mocks.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'hotel.rates.mealPlan.activate' })
    );
  });
  it('reports a property that no longer resolves rather than falling back to another', async () => {
    db.hotelProperty.findFirst.mockResolvedValue(null);
    await expect(caller().list({ branchId: BRANCH })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller().create(validCreate)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.hotelMealPlan.create).not.toHaveBeenCalled();
  });
});
