import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-817: the lost-sales chip tap and the settlement pass rewrite a branch's
// unfulfilled-demand rows and the customer's notify-when-back phone. The chip
// tap takes the counter's gate (canonical `pharmacy:counter`, the deny-wins
// counter family and an active branch assignment); settlement takes the
// manager or owner gate of the lost-sales summary. Both refuse before any
// demand row is read, and the chip tap never echoes the phone back.
// `can()` and the lost-sales module are not mocked; they run on the rows below.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };

const COUNTER: Rule = { capability: 'pharmacy:counter', effect: 'ALLOW' };
const MANAGER: Rule = { capability: 'pharmacy:manage', effect: 'ALLOW' };
const NO_PERMISSION = { code: 'FORBIDDEN', message: 'You do not have permission for this action.' };
const OUTSIDE = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };
const PHONE = '03001234567';

function fixture(
  roleRules: Rule[],
  options: { overrides?: Rule[]; role?: 'EMPLOYEE' | 'ADMIN'; assigned?: string[] } = {}
) {
  const member = {
    status: 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: { permissions: roleRules },
    permissionOverrides: options.overrides ?? [],
  };
  const stored = {
    id: 'demand-1',
    organizationId: 'org-a',
    branchId: 'branch-a',
    quantity: 2,
    unitPricePkrMinor: 500,
    visitType: 'PARTIAL',
    createdAt: new Date(),
    outcome: 'UNKNOWN',
    substituteProductId: null,
    notifyOptIn: true,
    notifyPhone: PHONE,
    lossProbability: 0.43,
    estLossPkrMinor: 430,
  };
  // Prisma returns only the selected fields; without a select, the whole row.
  const project = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
    select ? Object.fromEntries(Object.keys(select).map((key) => [key, row[key]])) : row;
  const db = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async () => member) },
    pharmacyBranch: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] }; organizationId?: string } }) =>
        args.where.organizationId !== 'org-a' ? [] : args.where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async (args?: { where?: { id?: string; organizationId?: string } }) =>
        args?.where?.organizationId === 'org-a' ? { id: args.where.id ?? 'branch-a' } : null
      ),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => (options.assigned ?? []).map((branchId) => ({ branchId }))),
    },
    unfulfilledDemandEvent: {
      findFirst: vi.fn(async (args: { select?: Record<string, boolean> }) =>
        project(stored, args.select)
      ),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      update: vi.fn(
        async (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) =>
          project({ ...stored, ...args.data }, args.select)
      ),
    },
  };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'user-a',
        role: options.role ?? 'EMPLOYEE',
        department: 'COUNTER',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

type Caller = ReturnType<ReturnType<typeof fixture>['caller']>;

const chipTap = (caller: Caller, branchId = 'branch-a') =>
  caller.setDemandOutcome({ branchId, demandId: 'demand-1', outcome: 'WENT_ELSEWHERE' });
const settle = (caller: Caller, branchId = 'branch-a') => caller.settleLostSales({ branchId });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DEV-817 setDemandOutcome authorization', () => {
  it('admits an assigned counter member and never returns the notify phone', async () => {
    const { caller, db } = fixture([COUNTER], { assigned: ['branch-a'] });
    const result = await chipTap(caller());
    expect(db.unfulfilledDemandEvent.update).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ id: 'demand-1', outcome: 'WENT_ELSEWHERE', notifyOptIn: true });
    expect(result).not.toHaveProperty('notifyPhone');
    expect(JSON.stringify(result)).not.toContain(PHONE);
  });

  it('refuses a member without the counter grant before reading the event', async () => {
    const { caller, db } = fixture([{ capability: 'reports:financial', effect: 'ALLOW' }], {
      assigned: ['branch-a'],
    });
    await expect(chipTap(caller())).rejects.toMatchObject(NO_PERMISSION);
    expect(db.unfulfilledDemandEvent.findFirst).not.toHaveBeenCalled();
    expect(db.unfulfilledDemandEvent.update).not.toHaveBeenCalled();
  });

  it('refuses a counter member whose override denies the counter', async () => {
    const { caller, db } = fixture([COUNTER], {
      overrides: [{ capability: 'pharmacy:counter', effect: 'DENY' }],
      assigned: ['branch-a'],
    });
    await expect(chipTap(caller())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.unfulfilledDemandEvent.update).not.toHaveBeenCalled();
  });

  it('refuses a counter member who is not assigned to the branch', async () => {
    const { caller, db } = fixture([COUNTER], { assigned: ['branch-b'] });
    await expect(chipTap(caller())).rejects.toMatchObject(OUTSIDE);
    expect(db.unfulfilledDemandEvent.findFirst).not.toHaveBeenCalled();
    expect(db.unfulfilledDemandEvent.update).not.toHaveBeenCalled();
  });

  it('refuses a new notify phone from a member outside the branch', async () => {
    const { caller, db } = fixture([COUNTER], { assigned: [] });
    await expect(
      caller().setDemandOutcome({
        branchId: 'branch-a',
        demandId: 'demand-1',
        outcome: 'WILL_RETURN',
        notifyOptIn: true,
        notifyPhone: '03119876543',
      })
    ).rejects.toMatchObject(OUTSIDE);
    expect(db.unfulfilledDemandEvent.update).not.toHaveBeenCalled();
  });
});

describe('DEV-817 settleLostSales authorization', () => {
  it('admits an assigned manager', async () => {
    const { caller, db } = fixture([MANAGER, COUNTER], { assigned: ['branch-a'] });
    await expect(settle(caller())).resolves.toMatchObject({ evaluated: 0, updated: 0 });
    expect(db.unfulfilledDemandEvent.findMany).toHaveBeenCalledOnce();
  });

  it('refuses a cashier holding only the counter grant', async () => {
    const { caller, db } = fixture([COUNTER], { assigned: ['branch-a'] });
    await expect(settle(caller())).rejects.toMatchObject(NO_PERMISSION);
    expect(db.unfulfilledDemandEvent.findMany).not.toHaveBeenCalled();
    expect(db.unfulfilledDemandEvent.update).not.toHaveBeenCalled();
  });

  it('refuses a manager who is not assigned to the branch', async () => {
    const { caller, db } = fixture([MANAGER, COUNTER], { assigned: ['branch-b'] });
    await expect(settle(caller())).rejects.toMatchObject(OUTSIDE);
    expect(db.unfulfilledDemandEvent.findMany).not.toHaveBeenCalled();
  });
});
