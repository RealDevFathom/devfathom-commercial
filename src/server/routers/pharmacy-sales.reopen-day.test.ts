import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-631: closing a day early must not block selling until midnight. Only the owner
// reopens today's closed day for trading, with a reason, and the counter learns the
// day is closed from its drawer status before a bill is built.
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
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  // Delegated staff can hold admin access too; reopening stays the owner's.
  can: vi.fn(async () => true),
}));
vi.mock('@/lib/pharmacy/day-close', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/day-close')>()),
  reopenPharmacyDayForTrading: vi.fn(async () => ({ id: 'reopen-1', closeId: 'close-1' })),
}));

import { reopenPharmacyDayForTrading } from '@/lib/pharmacy/day-close';
import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-1';
const businessDate = new Date('2026-11-02T00:00:00.000Z');

function fixture(role: 'ADMIN' | 'EMPLOYEE' = 'ADMIN') {
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ branchId: BRANCH }) },
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: [] },
        permissionOverrides: [],
      })),
    },
    pharmacyDrawerSession: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue({ id: 'close-1', reopen: null }),
    },
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
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

beforeEach(() => {
  vi.mocked(reopenPharmacyDayForTrading).mockClear();
  vi.mocked(annotateAudit).mockClear();
});

describe('pharmacySales.reopenDay', () => {
  it('lets the owner reopen the day with a reason, scoped and audited', async () => {
    const { caller } = fixture();
    await expect(
      caller.reopenDay({ branchId: BRANCH, businessDate, reason: 'Closed early by mistake' })
    ).resolves.toEqual({ id: 'reopen-1', closeId: 'close-1' });
    expect(reopenPharmacyDayForTrading).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: BRANCH, actorId: 'user-1' },
      { branchId: BRANCH, businessDate, reason: 'Closed early by mistake' }
    );
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        targetType: 'PharmacyDailyClose',
        targetId: 'close-1',
        metadata: { reopenId: 'reopen-1', businessDate: '2026-11-02' },
      })
    );
  });

  it('refuses delegated staff holding admin access before any write', async () => {
    const { caller } = fixture('EMPLOYEE');
    await expect(
      caller.reopenDay({ branchId: BRANCH, businessDate, reason: 'Late sale' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Owner access required.' });
    expect(reopenPharmacyDayForTrading).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty reason', { branchId: BRANCH, businessDate, reason: '   ' }],
    [
      'a business date carrying a time',
      { branchId: BRANCH, businessDate: new Date('2026-11-02T10:00:00Z'), reason: 'Why' },
    ],
  ])('rejects %s', async (_name, input) => {
    const { caller } = fixture();
    await expect(caller.reopenDay(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(reopenPharmacyDayForTrading).not.toHaveBeenCalled();
  });
});

describe('pharmacySales.drawerStatus closed day', () => {
  it('reports a closed business day to the counter', async () => {
    const { caller } = fixture('EMPLOYEE');
    await expect(
      caller.drawerStatus({ branchId: BRANCH, deviceId: 'device-1', businessDate })
    ).resolves.toEqual({ openDrawer: null, dayClosed: true });
  });

  it('reports the day open once the owner reopened its latest close', async () => {
    const { db, caller } = fixture('EMPLOYEE');
    db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1', reopen: { id: 'r-1' } });
    await expect(
      caller.drawerStatus({ branchId: BRANCH, deviceId: 'device-1', businessDate })
    ).resolves.toEqual({ openDrawer: null, dayClosed: false });
  });

  it('reads no close without a business date', async () => {
    const { db, caller } = fixture('EMPLOYEE');
    await expect(caller.drawerStatus({ branchId: BRANCH, deviceId: 'device-1' })).resolves.toEqual(
      { openDrawer: null }
    );
    expect(db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
  });
});
