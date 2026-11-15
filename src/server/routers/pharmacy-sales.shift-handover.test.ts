import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-695: the shift handover note at drawer close. Owner-only with financial reports,
// branch-scoped through `scopeFor`, built on the #728 check, and it writes nothing.
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
    $queryRaw: vi.fn().mockResolvedValue([]),
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
    pharmacyDrawerSession: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySaleReturn: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySaleEvent: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyEmergencyRxFollowUp: {
      count: vi.fn().mockResolvedValue(1),
      findFirst: vi.fn().mockResolvedValue({ createdAt: new Date('2026-10-19T08:00:00Z') }),
    },
    pharmacyCustomerOrder: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    pharmacyRestockInterest: { count: vi.fn().mockResolvedValue(0), update: vi.fn() },
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
  it('returns the owner a draft note with pending Rx, promises, cash and check flags', async () => {
    const note = await f.caller.shiftHandoverNote({ branchId: BRANCH, businessDate });
    expect(note).toMatchObject({
      draft: true,
      readOnly: true,
      closed: true,
      branchName: 'Main',
      pendingRx: { count: 1, oldestAt: '2026-10-19' },
      cash: { varianceMinor: -200_000 },
      flags: [expect.objectContaining({ kind: 'CLOSE_VARIANCE', severity: 'URGENT' })],
    });
    expect(note?.note).toContain('Shift handover — 2026-10-20');
  });

  it('writes nothing and takes no day lock', async () => {
    await f.caller.shiftHandoverNote({ branchId: BRANCH, businessDate });
    expect(f.db.$queryRaw).not.toHaveBeenCalled();
    expect(f.db.$executeRaw).not.toHaveBeenCalled();
    expect(f.db.pharmacyDailyClose.create).not.toHaveBeenCalled();
    expect(f.db.pharmacyDrawerSession.update).not.toHaveBeenCalled();
    expect(f.db.pharmacyCustomerOrder.update).not.toHaveBeenCalled();
    expect(f.db.pharmacyRestockInterest.update).not.toHaveBeenCalled();
  });

  it('refuses a non-owner before reading anything', async () => {
    const staff = fixture('EMPLOYEE');
    await expect(
      staff.caller.shiftHandoverNote({ branchId: BRANCH, businessDate })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(staff.db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
    expect(staff.db.pharmacyEmergencyRxFollowUp.count).not.toHaveBeenCalled();
  });

  it('refuses a non-owner delegated admin access and financial reports', async () => {
    vi.mocked(can).mockImplementation(async () => true);
    try {
      const staff = fixture('EMPLOYEE');
      await expect(
        staff.caller.shiftHandoverNote({ branchId: BRANCH, businessDate })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(staff.db.pharmacyCustomerOrder.findMany).not.toHaveBeenCalled();
    } finally {
      vi.mocked(can).mockImplementation(async (subject) => subject.role === 'ADMIN');
    }
  });

  it('refuses an owner denied financial reports before reading anything', async () => {
    vi.mocked(can).mockImplementation(
      async (subject, action) => subject.role === 'ADMIN' && action !== 'reports:financial'
    );
    try {
      await expect(
        f.caller.shiftHandoverNote({ branchId: BRANCH, businessDate })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
      expect(f.db.pharmacyEmergencyRxFollowUp.count).not.toHaveBeenCalled();
    } finally {
      vi.mocked(can).mockImplementation(async (subject) => subject.role === 'ADMIN');
    }
  });

  it('refuses a branch outside the organization', async () => {
    f.db.pharmacyBranch.findMany.mockResolvedValue([]);
    await expect(
      f.caller.shiftHandoverNote({ branchId: 'foreign-branch', businessDate })
    ).rejects.toBeDefined();
    expect(f.db.pharmacyEmergencyRxFollowUp.count).not.toHaveBeenCalled();
  });

  it('rejects a business date carrying a time', async () => {
    await expect(
      f.caller.shiftHandoverNote({
        branchId: BRANCH,
        businessDate: new Date('2026-10-20T05:00:00.000Z'),
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
