import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-860: the counter says why a sale cannot start. The server names each refusal of
// `create` and `addLine` with a safe reason code, and `saleReadiness` lists the same
// codes before the first scan. Neither reveals another tenant's or another user's data.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  annotateAudit: vi.fn(),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/regulatory', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sale-readiness', () => ({ evaluateCounterSaleReadiness: vi.fn() }));

import { assertStoredPharmacyMayOperate } from '@/lib/pharmacy/regulatory';
import { evaluateCounterSaleReadiness } from '@/lib/pharmacy/sale-readiness';
import { RefusalReason } from '@/server/refusal-reason';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const COUNTER: Rule[] = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }];
const PHARMACIST: Rule[] = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }];

function fixture({
  permissions = COUNTER,
  assigned = ['branch-1'],
  role = 'EMPLOYEE',
  branchInOrganization = true,
}: {
  permissions?: Rule[];
  assigned?: string[];
  role?: 'EMPLOYEE' | 'ADMIN';
  branchInOrganization?: boolean;
} = {}) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions },
        permissionOverrides: [],
      }),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        branchInOrganization ? where.id.in.map((id) => ({ id })) : []
      ),
      findFirst: vi.fn(async () => (branchInOrganization ? { id: 'branch-1' } : null)),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue(assigned.map((branchId) => ({ branchId }))),
    },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue({ id: 'drawer-1', businessDate: new Date() }),
    },
    pharmacySale: { create: vi.fn(async () => ({ id: 'sale-new', status: 'OPEN' })) },
    pharmacySaleEvent: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

const createBill = (f: ReturnType<typeof fixture>) =>
  f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' });

const addLine = (f: ReturnType<typeof fixture>) =>
  f.caller.addLine({
    branchId: 'branch-1',
    saleId: 'sale-1',
    medicineId: 'medicine-1',
    presentationId: 'presentation-1',
    packLevelId: 'pack-1',
    saleUnit: 'PACK',
    quantity: 1,
    canonicalUnitsPerSaleUnit: 10,
    idempotencyKey: 'line-1',
  });

const READY = { ready: true, blockers: [], warnings: [] };

/** The refusal keeps its DEV-607 wording; its reason is published as `data.reason`. */
const NOT_ASSIGNED = {
  code: 'FORBIDDEN',
  message: 'Branch is outside your scope.',
  cause: new RefusalReason('BRANCH_NOT_ASSIGNED'),
};

async function refusal(run: Promise<unknown>) {
  return run.then(
    () => expect.unreachable('expected a refusal'),
    (error: unknown) => error as { code: string; message: string; cause?: unknown }
  );
}

beforeEach(() => {
  vi.mocked(assertStoredPharmacyMayOperate).mockReset().mockResolvedValue(undefined);
  vi.mocked(evaluateCounterSaleReadiness).mockReset().mockResolvedValue(READY);
});

describe('sale refusals name their reason (DEV-860)', () => {
  it('refuses a new bill at a branch the operator is not assigned to as BRANCH_NOT_ASSIGNED', async () => {
    const f = fixture({ assigned: ['branch-other'] });
    const error = await refusal(createBill(f));
    expect(error).toMatchObject(NOT_ASSIGNED);
    expect(error.cause).toBeInstanceOf(RefusalReason);
    expect(assertStoredPharmacyMayOperate).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });

  it('refuses add-to-cart at a branch the operator is not assigned to as BRANCH_NOT_ASSIGNED', async () => {
    const f = fixture({ assigned: [] });
    const error = await refusal(addLine(f));
    expect(error).toMatchObject(NOT_ASSIGNED);
    expect(error.cause).toBeInstanceOf(RefusalReason);
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it('gives counterCart the same named answer as create and addLine', async () => {
    const f = fixture({ assigned: [] });
    const error = await refusal(f.caller.counterCart({ branchId: 'branch-1', saleId: 'sale-1' }));
    expect(error).toMatchObject(NOT_ASSIGNED);
  });

  it('names no reason for a branch outside the organization', async () => {
    for (const run of [createBill, addLine]) {
      const f = fixture({ branchInOrganization: false });
      const error = await refusal(run(f));
      expect(error).toMatchObject({ code: 'FORBIDDEN', message: 'Branch is outside your scope.' });
      expect(error.cause).not.toBeInstanceOf(RefusalReason);
    }
  });

  it('names no reason for an operator without counter access', async () => {
    const f = fixture({ permissions: [] });
    const error = await refusal(createBill(f));
    expect(error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'You do not have permission for this action.',
    });
    expect(error.cause).not.toBeInstanceOf(RefusalReason);
  });

  it('still lets an organization administrator open a bill at any active branch', async () => {
    const f = fixture({ assigned: [], role: 'ADMIN' });
    await expect(createBill(f)).resolves.toMatchObject({ id: 'sale-new' });
    expect(assertStoredPharmacyMayOperate).toHaveBeenCalledOnce();
  });

  it('opens the bill for an assigned operator', async () => {
    await expect(createBill(fixture())).resolves.toMatchObject({ id: 'sale-new' });
  });
});

describe('pharmacySales.saleReadiness (DEV-860)', () => {
  it('reports a missing assignment without evaluating the branch', async () => {
    const f = fixture({ assigned: ['branch-other'] });
    await expect(
      f.caller.saleReadiness({ branchId: 'branch-1', deviceId: 'counter-device' })
    ).resolves.toEqual({
      ready: false,
      blockers: ['BRANCH_NOT_ASSIGNED'],
      warnings: [],
      canFixSetup: false,
    });
    expect(evaluateCounterSaleReadiness).not.toHaveBeenCalled();
  });

  it('evaluates the branch for an assigned cashier, who cannot change setup', async () => {
    vi.mocked(evaluateCounterSaleReadiness).mockResolvedValueOnce({
      ready: false,
      blockers: ['PROFILE_MISSING'],
      warnings: ['NO_INDEPENDENT_PHARMACIST'],
    });
    const f = fixture();
    await expect(
      f.caller.saleReadiness({ branchId: 'branch-1', deviceId: 'counter-device' })
    ).resolves.toEqual({
      ready: false,
      blockers: ['PROFILE_MISSING'],
      warnings: ['NO_INDEPENDENT_PHARMACIST'],
      canFixSetup: false,
    });
    expect(evaluateCounterSaleReadiness).toHaveBeenCalledWith(f.db, {
      organizationId: 'org-1',
      branchId: 'branch-1',
      actorId: 'actor-1',
      deviceId: 'counter-device',
      takesPayment: true,
    });
  });

  it('asks no drawer of a pharmacist who takes no payment', async () => {
    const f = fixture({ permissions: PHARMACIST });
    await f.caller.saleReadiness({ branchId: 'branch-1' });
    expect(evaluateCounterSaleReadiness).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining({ takesPayment: false, deviceId: null })
    );
  });

  it('tells the counter an organization administrator may fix setup', async () => {
    const f = fixture({ assigned: [], role: 'ADMIN' });
    await expect(f.caller.saleReadiness({ branchId: 'branch-1' })).resolves.toMatchObject({
      canFixSetup: true,
    });
  });

  it('keeps the counter gate: no readiness for a branch outside the organization', async () => {
    const f = fixture({ branchInOrganization: false });
    await expect(f.caller.saleReadiness({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(evaluateCounterSaleReadiness).not.toHaveBeenCalled();
  });

  it('keeps the counter gate: no readiness without counter access', async () => {
    const f = fixture({ permissions: [] });
    await expect(f.caller.saleReadiness({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(evaluateCounterSaleReadiness).not.toHaveBeenCalled();
  });
});
