import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-505: the existing pharmacy Manager role template, end to end through the
// real ABAC engine. A Manager runs day close, purchasing, inventory and the
// operational reports for the branch they are assigned to, and is refused every
// other branch. The grants are read from the template itself, so a change to it
// is caught here.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/day-close', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/day-close')>()),
  readPharmacyClose: vi.fn(async () => ({ sourceHash: 'a'.repeat(64) })),
}));
vi.mock('@/lib/pharmacy/reports', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/reports')>()),
  readPharmacyOwnerCommandCentre: vi.fn(async () => ({
    metrics: { salesMinor: 100, marginMinor: 50, openStockSignals: 2 },
  })),
}));

import { can, subjectFromSession } from '@/lib/abac';
import { readPharmacyClose } from '@/lib/pharmacy/day-close';
import { procurementBranchIds } from '@/lib/pharmacy/procurement-access';
import { readPharmacyOwnerCommandCentre } from '@/lib/pharmacy/reports';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { managerBranchIds } from '../pharmacy-manager-branches';
import { router, type TRPCContext } from '../trpc';
import { pharmacyAccessRouter } from './pharmacy-access';
import { pharmacyReportsRouter } from './pharmacy-reports';
import { canAccessDayClose, pharmacySalesRouter } from './pharmacy-sales';

const app = router({
  pharmacySales: pharmacySalesRouter,
  pharmacyReports: pharmacyReportsRouter,
  pharmacyAccess: pharmacyAccessRouter,
});

const ASSIGNED = 'branch-assigned';
const OTHER = 'branch-other';
const ORG = 'org-1';
const businessDate = new Date('2026-11-14T00:00:00.000Z');

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const template = (key: string): Rule[] =>
  PHARMACY_ROLE_TEMPLATES.find((role) => role.key === key)!.capabilities.map((capability) => ({
    capability,
    effect: 'ALLOW' as const,
  }));
const deny = (capability: string): Rule => ({ capability, effect: 'DENY' });

function fixture({
  roleRules = template('manager'),
  overrides = [] as Rule[],
  role = 'EMPLOYEE' as 'ADMIN' | 'EMPLOYEE',
  assigned = [ASSIGNED],
}: {
  roleRules?: Rule[];
  overrides?: Rule[];
  role?: 'ADMIN' | 'EMPLOYEE';
  assigned?: string[];
} = {}) {
  const branches = [
    { id: ASSIGNED, name: 'Assigned', code: 'A', city: null },
    { id: OTHER, name: 'Other', code: 'O', city: null },
  ];
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
    $queryRaw: vi.fn().mockResolvedValue([]),
    organization: {
      findUnique: vi.fn(async () => ({ currency: 'PKR', timezone: 'Asia/Karachi' })),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id?: { in: string[] } } }) =>
        branches.filter((branch) => !where.id || where.id.in.includes(branch.id))
      ),
      // The counter's rail check: a Manager template does not carry the counter.
      findFirst: vi.fn(async () => null),
    },
    pharmacySupplier: { findMany: vi.fn(async () => []) },
    pharmacyBranchAssignment: {
      findFirst: vi.fn(
        async ({ where }: { where: { branchId: string; userId: string; active: boolean } }) =>
          where.userId === 'manager-1' && where.active && assigned.includes(where.branchId)
            ? { branchId: where.branchId }
            : null
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string; active: boolean } }) =>
        where.userId === 'manager-1' && where.active
          ? assigned.map((branchId) => ({ branchId }))
          : []
      ),
    },
    user: {
      findUnique: vi.fn(async () => ({
        role,
        status: 'ACTIVE',
        organizationId: ORG,
        organizationRole: { key: 'manager', isSystem: true, permissions: roleRules },
        permissionOverrides: overrides,
      })),
    },
  };
  const ctx = {
    db,
    entitlements: {
      organizationId: ORG,
      enabledModules: ['pharmacy-core', 'pharmacy-counter', 'pharmacy-reports'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'manager-1', role, status: 'ACTIVE', organizationId: ORG },
    },
    organization: { id: ORG, vertical: 'PHARMACY', timezone: 'Asia/Karachi' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, ctx, caller: app.createCaller(ctx) };
}

const FORBIDDEN = { code: 'FORBIDDEN' };

beforeEach(() => {
  vi.mocked(readPharmacyClose).mockClear();
  vi.mocked(readPharmacyOwnerCommandCentre).mockClear();
});

describe('DEV-505 Manager template: day close', () => {
  it('offers day close for the assigned branch only', async () => {
    const { ctx, caller } = fixture();
    expect(await canAccessDayClose(ctx)).toBe(true);
    const result = await caller.pharmacySales.dayCloseBranches();
    expect(result.branches.map((branch) => branch.id)).toEqual([ASSIGNED]);
    expect(result).toMatchObject({ currency: 'PKR', timezone: 'Asia/Karachi' });
  });

  it('closes the assigned branch and is refused another branch', async () => {
    const { caller } = fixture();
    await caller.pharmacySales.closePreview({ branchId: ASSIGNED, businessDate });
    expect(readPharmacyClose).toHaveBeenCalledTimes(1);
    await expect(
      caller.pharmacySales.closePreview({ branchId: OTHER, businessDate })
    ).rejects.toMatchObject(FORBIDDEN);
    expect(readPharmacyClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a Manager with no branch assignment', async () => {
    const { ctx, caller } = fixture({ assigned: [] });
    expect(await canAccessDayClose(ctx)).toBe(false);
    await expect(caller.pharmacySales.dayCloseBranches()).rejects.toMatchObject(FORBIDDEN);
  });

  it('lets an explicit pharmacy:close DENY beat the Manager template', async () => {
    const { ctx, caller } = fixture({ overrides: [deny('pharmacy:close')] });
    expect(await canAccessDayClose(ctx)).toBe(false);
    await expect(caller.pharmacySales.dayCloseBranches()).rejects.toMatchObject(FORBIDDEN);
  });

  it('refuses a Cashier', async () => {
    const { ctx, caller } = fixture({ roleRules: template('cashier') });
    expect(await canAccessDayClose(ctx)).toBe(false);
    await expect(caller.pharmacySales.dayCloseBranches()).rejects.toMatchObject(FORBIDDEN);
  });

  it('keeps every branch for an administrator', async () => {
    const { caller } = fixture({ role: 'ADMIN', roleRules: [], assigned: [] });
    const result = await caller.pharmacySales.dayCloseBranches();
    expect(result.branches.map((branch) => branch.id)).toEqual([ASSIGNED, OTHER]);
  });
});

describe('DEV-505 Manager template: reports', () => {
  it('lists only the assigned branch', async () => {
    const { caller } = fixture();
    expect((await caller.pharmacyReports.branches()).branches.map((b) => b.id)).toEqual([ASSIGNED]);
  });

  it('runs the command centre for the assigned branch only, without financial figures', async () => {
    const { caller } = fixture();
    const result = await caller.pharmacyReports.commandCentre({
      from: '2026-11-08',
      to: '2026-11-14',
    });
    expect(readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branchIds: [ASSIGNED] })
    );
    expect(result.metrics).toMatchObject({ salesMinor: null, marginMinor: null });
    expect(result.metrics.openStockSignals).toBe(2);
    await expect(
      caller.pharmacyReports.commandCentre({
        branchId: OTHER,
        from: '2026-11-08',
        to: '2026-11-14',
      })
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it('refuses another branch in the daily work pack', async () => {
    const { caller } = fixture();
    await expect(
      caller.pharmacyReports.dailyWorkPack({
        branchId: OTHER,
        from: '2026-11-14',
        to: '2026-11-14',
        asOf: '2026-11-14T10:00:00.000+05:00',
      })
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it('keeps the owner-only reports closed to a Manager', async () => {
    const { caller } = fixture();
    await expect(
      caller.pharmacyReports.anomalySignals({ from: '2026-11-08', to: '2026-11-14' })
    ).rejects.toMatchObject(FORBIDDEN);
  });

  it('refuses a Manager whose reports are explicitly denied, or who has no branch', async () => {
    for (const options of [{ overrides: [deny('reports:operational')] }, { assigned: [] }]) {
      const { caller } = fixture(options);
      await expect(caller.pharmacyReports.catalog()).rejects.toMatchObject(FORBIDDEN);
      await expect(
        caller.pharmacyReports.commandCentre({ from: '2026-11-08', to: '2026-11-14' })
      ).rejects.toMatchObject(FORBIDDEN);
    }
  });

  it('refuses a Cashier', async () => {
    const { caller } = fixture({ roleRules: template('cashier') });
    await expect(caller.pharmacyReports.catalog()).rejects.toMatchObject(FORBIDDEN);
  });

  it('keeps organization-wide reports for an Auditor', async () => {
    const { caller } = fixture({ roleRules: template('auditor'), assigned: [] });
    await caller.pharmacyReports.commandCentre({ from: '2026-11-08', to: '2026-11-14' });
    expect(readPharmacyOwnerCommandCentre).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ branchIds: [ASSIGNED, OTHER] })
    );
  });
});

describe('DEV-505 Manager template: purchasing and inventory', () => {
  it('scopes purchasing to the assigned branch', async () => {
    const { db } = fixture();
    expect(await procurementBranchIds(db as unknown as ScopedDb, ORG, 'manager-1')).toEqual([
      ASSIGNED,
    ]);
  });

  it('grants purchasing, approval and inventory, but never the tenant-wide grants', async () => {
    const { db, ctx } = fixture();
    const subject = subjectFromSession(ctx.session!.user);
    const decide = (action: Parameters<typeof can>[1]) =>
      can(subject, action, undefined, { db: db as never });
    for (const action of [
      'pharmacy:procurement',
      'pharmacy:procurement-approve',
      'pharmacy:inventory',
      'pharmacy:manage',
    ] as const)
      expect(await decide(action)).toBe(true);
    for (const action of ['pharmacy:close', 'reports:operational', 'reports:financial'] as const)
      expect(await decide(action)).toBe(false);
  });
});

describe('DEV-505 Manager template: rail', () => {
  it('offers day close, purchasing and reports from the server decision', async () => {
    const { caller } = fixture();
    const { capabilities } = await caller.pharmacyAccess.navigation();
    expect(capabilities).toEqual(
      expect.arrayContaining(['pharmacy:procurement', 'reports:operational', 'pharmacy:close'])
    );
    expect(capabilities).not.toContain('pharmacy:prescriptions');
    expect(capabilities).not.toContain('pharmacy:dispense');
  });

  it('offers neither day close nor reports to a Manager with no branch', async () => {
    const { caller } = fixture({ assigned: [] });
    const { capabilities } = await caller.pharmacyAccess.navigation();
    expect(capabilities).not.toContain('pharmacy:close');
    expect(capabilities).not.toContain('reports:operational');
  });
});

describe('DEV-505 managerBranchIds', () => {
  it('returns no branch for a member without pharmacy:manage', async () => {
    const { ctx } = fixture({ roleRules: template('inventory') });
    expect(await managerBranchIds(ctx, 'pharmacy:close')).toEqual([]);
  });

  it('asks only for active assignments on active branches of this tenant', async () => {
    const { ctx, db } = fixture();
    expect(await managerBranchIds(ctx, 'pharmacy:close')).toEqual([ASSIGNED]);
    expect(db.pharmacyBranchAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG,
          userId: 'manager-1',
          active: true,
          branch: { organizationId: ORG, active: true },
        },
      })
    );
  });
});
