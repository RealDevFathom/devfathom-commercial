import { beforeEach, describe, expect, it, vi } from 'vitest';

// #728: the owner's read-only cash-close anomaly check. Owner-only (adminProcedure),
// branch-scoped through `scopeFor`, and it writes nothing.
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
}));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  // The capability engine's decision for this test: only the owner role holds admin access.
  can: vi.fn(async (subject: { role?: string }) => subject.role === 'ADMIN'),
}));

import { can } from '@/lib/abac';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-1';
const businessDate = new Date('2026-10-20T00:00:00.000Z');

function fixture(role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN') {
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        {
          pendingRx: 2,
          openOrders: 1,
          restockPromises: 0,
          expectedMinor: 500000,
          countedMinor: 300000,
          varianceMinor: -200000,
        },
      ]),
    $executeRaw: vi.fn(),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn().mockResolvedValue({ id: BRANCH, name: 'Main' }),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'close-1',
        sequence: 1,
        cashExpectedMinor: 500_000,
        cashCountedMinor: 300_000,
        cashVarianceMinor: -200_000,
        reason: 'Short',
      }),
      create: vi.fn(),
    },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue({ businessDate }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
    },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySaleReturn: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySaleEvent: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const caller = app.createCaller({
    db,
    entitlements: {
      organizationId: 'org-1',
      enabledModules: ['pharmacy-counter', 'pharmacy-reports'],
      modules: [],
    },
    session: {
      expires: 'later',
      user: { id: 'user-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
  return { db, caller };
}

let f: ReturnType<typeof fixture>;
beforeEach(() => {
  f = fixture();
});

describe('pharmacySales.shiftHandoverNote', () => {
  it('returns an owner draft in a consistent read transaction', async () => {
    const result = await f.caller.shiftHandoverNote({
      branchId: BRANCH,
      drawerSessionId: 'drawer-a',
    });
    expect(result).toMatchObject({
      draft: true,
      readOnly: true,
      facts: { pendingRx: 2, varianceMinor: -200000 },
    });
    expect(f.db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
    expect(f.db.pharmacyDrawerSession.update).not.toHaveBeenCalled();
  });
  it('denies staff even with delegated admin and financial-report grants', async () => {
    vi.mocked(can).mockResolvedValue(true);
    try {
      const staff = fixture('EMPLOYEE');
      await expect(
        staff.caller.shiftHandoverNote({ branchId: BRANCH, drawerSessionId: 'drawer-a' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(staff.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
    } finally {
      vi.mocked(can).mockImplementation(async (subject) => subject.role === 'ADMIN');
    }
  });
  it('denies an owner explicitly denied financial reports before evidence reads', async () => {
    vi.mocked(can).mockImplementation(async (_, action) => action !== 'reports:financial');
    try {
      await expect(
        f.caller.shiftHandoverNote({ branchId: BRANCH, drawerSessionId: 'drawer-a' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
    } finally {
      vi.mocked(can).mockImplementation(async (subject) => subject.role === 'ADMIN');
    }
  });
  it('denies a foreign branch before reading the drawer', async () => {
    f.db.pharmacyBranch.findMany.mockResolvedValue([]);
    await expect(
      f.caller.shiftHandoverNote({ branchId: 'foreign', drawerSessionId: 'drawer-a' })
    ).rejects.toBeDefined();
    expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
  });
  it('uses the same opaque refusal for an open, foreign or missing drawer', async () => {
    f.db.pharmacyDrawerSession.findFirst.mockResolvedValue(null);
    await expect(
      f.caller.shiftHandoverNote({ branchId: BRANCH, drawerSessionId: 'foreign' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Closed drawer not found.' });
    expect(f.db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
  });
});
