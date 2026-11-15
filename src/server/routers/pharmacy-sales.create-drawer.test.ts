import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-725: opening the drawer is the first step of the shift. The counter used to
// let a cashier build a whole bill on a device with no OPEN drawer and only refused
// it at payment. Creating a counter bill now requires this device's OPEN drawer, on
// the server, so no client can start a bill it cannot then charge.
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
vi.mock('@/lib/pharmacy/regulatory', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/regulatory')>()),
  assertStoredPharmacyMayOperate: vi.fn(),
}));

import {
  assertStoredPharmacyMayOperate,
  BranchOperationDeniedError,
} from '@/lib/pharmacy/regulatory';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

function fixture(openDrawer: { id: string } | null) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyDrawerSession: { findFirst: vi.fn().mockResolvedValue(openDrawer) },
    pharmacySale: {
      create: vi.fn(async ({ data }: { data: { status: string } }) => ({
        id: 'sale-new',
        status: data.status,
      })),
    },
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
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext;
  return { db, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.mocked(assertStoredPharmacyMayOperate).mockReset().mockResolvedValue(undefined);
});

describe('pharmacySales.create drawer gate (DEV-725)', () => {
  it('refuses a counter bill on a device with no OPEN drawer, before any bill is written', async () => {
    const f = fixture(null);
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DRAWER_NOT_OPEN' });
    expect(f.db.pharmacyDrawerSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          branchId: 'branch-1',
          deviceId: 'counter-device',
          status: 'OPEN',
        },
      })
    );
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
    expect(f.db.pharmacySaleEvent.create).not.toHaveBeenCalled();
  });

  it('refuses a counter bill that does not name its counter device', async () => {
    const f = fixture({ id: 'drawer-1' });
    await expect(f.caller.create({ branchId: 'branch-1', quotation: false })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(f.caller.create({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });

  it('starts the bill once this device has an OPEN drawer', async () => {
    const f = fixture({ id: 'drawer-1' });
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).resolves.toMatchObject({ id: 'sale-new', status: 'OPEN' });
    expect(f.db.pharmacySale.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        organizationId: 'org-1',
        branchId: 'branch-1',
        createdByUserId: 'actor-1',
        status: 'OPEN',
      },
    });
  });

  it('keeps quotations free of the drawer: they take no payment', async () => {
    const f = fixture(null);
    await expect(f.caller.create({ branchId: 'branch-1', quotation: true })).resolves.toMatchObject(
      { status: 'QUOTATION' }
    );
    expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
  });

  it('lets the regulatory refusal (and its audit) win over a closed drawer', async () => {
    const denied = new BranchOperationDeniedError('ORGANIZATION_NOT_ACTIVE');
    vi.mocked(assertStoredPharmacyMayOperate).mockRejectedValueOnce(denied);
    const f = fixture(null);
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'ORGANIZATION_NOT_ACTIVE' });
    expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });
});
