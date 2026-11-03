import { beforeEach, describe, expect, it, vi } from 'vitest';

// The close family (`dailyClose`, `closePreview`, `closeDay`) calls the same
// settlement library as the drawer family, which raises typed
// `PharmacySettlementError`s. Without `fail` they reached the client as a 500
// carrying the raw reason; with it they are the same typed refusals the drawer
// procedures give (OPEN_DRAWER is a CONFLICT), and the library's own TRPCErrors
// pass through untouched.
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

import { computePharmacyClose } from '@/lib/pharmacy/settlement';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-1';
const businessDate = new Date('2026-10-20T00:00:00.000Z');
const openDrawer = {
  id: 'drawer-1',
  deviceId: 'counter-device',
  status: 'OPEN',
  openedAt: new Date('2026-10-20T04:12:00.000Z'),
  openedByActorId: 'actor-1',
  countedCashMinor: null,
  movements: [{ kind: 'OPENING_FLOAT', amountMinor: 500 }],
};
/** The hash the preview computes for one open drawer expecting 500 and nothing sold. */
const previewHash = computePharmacyClose({
  tenders: [],
  sales: [],
  refunds: [],
  drawers: [{ id: openDrawer.id, expectedMinor: 500, countedMinor: 0 }],
}).sourceHash;

function fixture() {
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyBranch: {
      // `scopeFor`: the branch is an active branch of the organization.
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      // The close read's own branch lookup.
      findFirst: vi.fn().mockResolvedValue({ id: BRANCH, name: 'Main' }),
    },
    // The close read names the workspace's zone.
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    pharmacyDailyClose: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    pharmacyDrawerSession: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([openDrawer]),
      update: vi.fn(),
    },
    pharmacyDrawerMovement: { create: vi.fn() },
    pharmacySale: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyRefund: { findMany: vi.fn().mockResolvedValue([]) },
    // The close read and cut total the day's tenders by type (Z-report split).
    pharmacyTender: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findMany: vi.fn().mockResolvedValue([{ id: 'actor-1', name: 'Ayesha Karim' }]),
      // The manager-or-owner gate: a solo owner (tenant ADMIN with no organization role).
      findUnique: vi.fn().mockResolvedValue({ organizationRole: null, permissionOverrides: [] }),
    },
  };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'owner-1', role: 'ADMIN', status: 'ACTIVE', organizationId: 'org-1' },
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

describe('pharmacy close family refusals', () => {
  it('answers a daily close with a drawer still open as a CONFLICT, writing no close', async () => {
    f.db.pharmacyDrawerSession.count.mockResolvedValue(1);
    await expect(f.caller.dailyClose({ branchId: BRANCH, businessDate })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'OPEN_DRAWER',
    });
    expect(f.db.pharmacyDailyClose.create).not.toHaveBeenCalled();
  });

  it('answers a second daily close without a reopen reason as a BAD_REQUEST', async () => {
    f.db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1', sequence: 1 });
    await expect(f.caller.dailyClose({ branchId: BRANCH, businessDate })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'REOPEN_REASON_REQUIRED',
    });
    expect(f.db.pharmacyDailyClose.create).not.toHaveBeenCalled();
  });

  it('answers a close-day drawer that is no longer open with the typed reason', async () => {
    await expect(
      f.caller.closeDay({
        branchId: BRANCH,
        businessDate,
        sourceHash: previewHash,
        counts: [{ drawerSessionId: openDrawer.id, countedCashMinor: 500 }],
        varianceNote: '',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DRAWER_NOT_OPEN' });
    expect(f.db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
    expect(f.db.pharmacyDailyClose.create).not.toHaveBeenCalled();
  });

  it('keeps the close-day CONFLICT for a day that changed since the preview', async () => {
    await expect(
      f.caller.closeDay({
        branchId: BRANCH,
        businessDate,
        sourceHash: 'b'.repeat(64),
        counts: [{ drawerSessionId: openDrawer.id, countedCashMinor: 500 }],
        varianceNote: '',
      })
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The day changed. Refresh the preview and recount before closing.',
    });
  });

  it('answers a preview over an unreadable cash movement with the typed reason', async () => {
    f.db.pharmacyDrawerSession.findMany.mockResolvedValue([
      { ...openDrawer, movements: [{ kind: 'PAID_IN', amountMinor: 0 }] },
    ]);
    await expect(f.caller.closePreview({ branchId: BRANCH, businessDate })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'INVALID_AMOUNT',
    });
  });
});
