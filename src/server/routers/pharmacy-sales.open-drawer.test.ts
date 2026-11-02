import { describe, expect, it, vi } from 'vitest';

// POS-07 regression: a second "Open drawer" on the same counter device raced into the
// partial unique index `pharmacy_one_open_drawer_per_device` and tRPC answered the raw
// Prisma P2002 as a 500. The router must answer the typed OPEN_DRAWER reason instead.
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

import { Prisma } from '@/generated/prisma/client';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const input = {
  branchId: 'branch-1',
  deviceId: 'counter-device',
  businessDate: new Date('2026-10-20T00:00:00.000Z'),
  openingFloatMinor: 0,
};

type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };
const dispense: Permission = { capability: 'pharmacy:dispense', effect: 'ALLOW' };
const counter: Permission = { capability: 'pharmacy:counter', effect: 'ALLOW' };

function fixture(
  options: {
    openDrawer?: { id: string } | null;
    createError?: unknown;
    branch?: boolean;
    permissions?: Permission[];
  } = {}
) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: { permissions: options.permissions ?? [] },
        permissionOverrides: [],
      }),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ currency: 'PKR', timezone: 'UTC' }) },
    pharmacyBranch: {
      findMany: vi.fn(
        async ({ where }: { where: { id?: { in: string[] }; organizationId: string } }) =>
          options.branch === false ? [] : (where.id?.in ?? ['branch-1']).map((id) => ({ id }))
      ),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue(options.openDrawer ?? null),
      create: options.createError
        ? vi.fn().mockRejectedValue(options.createError)
        : vi
            .fn()
            .mockResolvedValue({ id: 'drawer-new', status: 'OPEN', deviceId: 'counter-device' }),
    },
    pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
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

describe('pharmacySales.openDrawer', () => {
  it('refuses a branch that is missing, inactive, or outside the session organization', async () => {
    const f = fixture({ branch: false });
    await expect(f.caller.openDrawer(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(f.db.pharmacyBranch.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['branch-1'] }, organizationId: 'org-1', active: true },
      select: { id: true },
    });
    expect(f.db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
  });

  it('opens the first drawer for a device', async () => {
    const f = fixture();
    await expect(f.caller.openDrawer(input)).resolves.toMatchObject({ id: 'drawer-new' });
    expect(f.db.pharmacyDrawerSession.create).toHaveBeenCalledTimes(1);
  });

  it('answers a second open on the same device with a typed CONFLICT, not a 500', async () => {
    const f = fixture({ openDrawer: { id: 'drawer-open' } });
    await expect(f.caller.openDrawer(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'OPEN_DRAWER',
    });
    expect(f.db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
  });

  it('answers the unique-index race with the same typed CONFLICT', async () => {
    const race = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: 'pharmacy_one_open_drawer_per_device' },
    });
    const f = fixture({ createError: race });
    await expect(f.caller.openDrawer(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'OPEN_DRAWER',
    });
  });

  it('answers a closed business day with the typed BAD_REQUEST reason', async () => {
    const f = fixture();
    f.db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1' });
    await expect(f.caller.openDrawer(input)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'DAY_CLOSED',
    });
  });
});

describe('pharmacySales.counterBranches settlement authorization', () => {
  it.each([
    ['dispensing-only pharmacist', [dispense], false],
    ['counter staff', [counter], true],
    ['pharmacist with counter grant', [dispense, counter], true],
    ['explicit counter denial', [counter, { ...counter, effect: 'DENY' as const }], false],
  ] as const)('reports the canonical decision for %s', async (_name, permissions, allowed) => {
    const f = fixture({ permissions: [...permissions] });
    await expect(f.caller.counterBranches()).resolves.toMatchObject({
      canSettlePayments: allowed,
    });
  });
});

describe('pharmacySales.drawerStatus', () => {
  it('reports the open drawer for this device', async () => {
    const f = fixture({ openDrawer: { id: 'drawer-open' } });
    f.db.pharmacyDrawerSession.findFirst.mockResolvedValue({
      id: 'drawer-open',
      businessDate: input.businessDate,
      openedAt: new Date('2026-10-20T04:05:00.000Z'),
      openingFloatMinor: 500,
    });
    await expect(
      f.caller.drawerStatus({ branchId: 'branch-1', deviceId: 'counter-device' })
    ).resolves.toEqual({
      openDrawer: {
        id: 'drawer-open',
        businessDate: input.businessDate,
        openedAt: new Date('2026-10-20T04:05:00.000Z'),
        openingFloatMinor: 500,
      },
    });
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
  });

  it('reports no drawer when none is open', async () => {
    const f = fixture();
    await expect(
      f.caller.drawerStatus({ branchId: 'branch-1', deviceId: 'counter-device' })
    ).resolves.toEqual({ openDrawer: null });
  });
});
