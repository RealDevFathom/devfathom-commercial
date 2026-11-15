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
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  createSale: vi.fn(async (_db: unknown, _scope: unknown, quotation: boolean) => ({
    id: 'sale-new',
    status: quotation ? 'QUOTATION' : 'OPEN',
  })),
}));

import { createSale } from '@/lib/pharmacy/sales';
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

beforeEach(() => vi.mocked(createSale).mockClear());

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
    expect(createSale).not.toHaveBeenCalled();
  });

  it('refuses a counter bill that does not name its counter device', async () => {
    const f = fixture({ id: 'drawer-1' });
    await expect(f.caller.create({ branchId: 'branch-1', quotation: false })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(f.caller.create({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(createSale).not.toHaveBeenCalled();
  });

  it('starts the bill once this device has an OPEN drawer', async () => {
    const f = fixture({ id: 'drawer-1' });
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).resolves.toMatchObject({ id: 'sale-new', status: 'OPEN' });
    expect(createSale).toHaveBeenCalledExactlyOnceWith(
      f.db,
      { organizationId: 'org-1', branchId: 'branch-1', actorId: 'actor-1' },
      false
    );
  });

  it('keeps quotations free of the drawer: they take no payment', async () => {
    const f = fixture(null);
    await expect(f.caller.create({ branchId: 'branch-1', quotation: true })).resolves.toMatchObject(
      { status: 'QUOTATION' }
    );
    expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
  });
});
