import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

function fixture(
  options: {
    openDrawer?: { id: string } | null;
    createError?: unknown;
    branch?: boolean;
    /** DEV-1056: the registered counter computer the device id names. */
    registeredDevice?: { branchId: string; status: 'ACTIVE' | 'REVOKED' } | null;
  } = {}
) {
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: {
          permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
      // DEV-821: the name of the cashier who runs an open till.
      findFirst: vi.fn().mockResolvedValue(null),
    },
    pharmacyBranch: {
      findMany: vi.fn(
        async ({ where }: { where: { id: { in: string[] }; organizationId: string } }) =>
          options.branch === false ? [] : where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => (options.branch === false ? null : { id: 'branch-1' })),
    },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Asia/Karachi' }) },
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]),
    },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue(options.openDrawer ?? null),
      create: options.createError
        ? vi.fn().mockRejectedValue(options.createError)
        : vi
            .fn()
            .mockResolvedValue({ id: 'drawer-new', status: 'OPEN', deviceId: 'counter-device' }),
    },
    // DEV-1056: the registered counter computer the device id names, if any.
    pharmacyRegisteredDevice: {
      findFirst: vi.fn().mockResolvedValue(options.registeredDevice ?? null),
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

// DEV-630: money writes book on the branch's current business day, so the clock is
// pinned to the fixture's day (14:00 in Karachi).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T09:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('pharmacySales.openDrawer', () => {
  it('refuses a branch that is missing, inactive, or outside the session organization', async () => {
    const f = fixture({ branch: false });
    await expect(f.caller.openDrawer(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
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

  // DEV-1056, interim: a registered counter computer opens a drawer only while it is active
  // at this branch. An id that names no registered computer is not looked at any further.
  const NOT_USABLE = {
    code: 'FORBIDDEN',
    message:
      'This counter computer is not active at this branch. Ask a manager to register it again.',
  };

  it('looks the device id up among the organization’s registered counter computers', async () => {
    const f = fixture();
    await f.caller.openDrawer(input);
    expect(f.db.pharmacyRegisteredDevice.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { organizationId: 'org-1', id: 'counter-device' },
      select: { branchId: true, status: true },
    });
  });

  it('opens a drawer for a registered counter computer active at this branch', async () => {
    const f = fixture({ registeredDevice: { branchId: 'branch-1', status: 'ACTIVE' } });
    await expect(f.caller.openDrawer(input)).resolves.toMatchObject({ id: 'drawer-new' });
    expect(f.db.pharmacyDrawerSession.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['revoked', { branchId: 'branch-1', status: 'REVOKED' }],
    ['registered at another branch', { branchId: 'branch-2', status: 'ACTIVE' }],
    ['revoked at another branch', { branchId: 'branch-2', status: 'REVOKED' }],
  ] as const)(
    'refuses a registered counter computer that is %s, before any drawer read or write',
    async (_, registeredDevice) => {
      const f = fixture({ registeredDevice });
      await expect(f.caller.openDrawer(input)).rejects.toMatchObject(NOT_USABLE);
      expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
      expect(f.db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
    }
  );

  it('opens a drawer for an unregistered browser id exactly as before', async () => {
    const f = fixture({ registeredDevice: null });
    const deviceId = 'counter-6f1c2a52-0d3e-4c58-9d0b-1a2b3c4d5e6f';
    await expect(f.caller.openDrawer({ ...input, deviceId })).resolves.toMatchObject({
      id: 'drawer-new',
    });
    expect(f.db.pharmacyDrawerSession.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deviceId }) })
    );
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

describe('pharmacySales.drawerStatus', () => {
  it('reports the open drawer for this device and who runs it', async () => {
    const f = fixture({ openDrawer: { id: 'drawer-open' } });
    const drawer = {
      id: 'drawer-open',
      businessDate: input.businessDate,
      openedAt: new Date('2026-10-20T04:05:00.000Z'),
      openingFloatMinor: 500,
      openedByActorId: 'manager-1',
      operatingCashierId: 'actor-1',
    };
    f.db.pharmacyDrawerSession.findFirst.mockResolvedValue(drawer);
    f.db.user.findFirst.mockResolvedValue({ name: 'Asha' });
    await expect(
      f.caller.drawerStatus({ branchId: 'branch-1', deviceId: 'counter-device' })
    ).resolves.toEqual({
      openDrawer: drawer,
      // DEV-821: a manager opened the till for this cashier, who runs it.
      operatingCashier: { name: 'Asha', isYou: true },
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
    expect(f.db.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'actor-1', organizationId: 'org-1' },
      select: { name: true },
    });
  });

  it('says when another cashier runs the till', async () => {
    const f = fixture();
    f.db.pharmacyDrawerSession.findFirst.mockResolvedValue({
      id: 'drawer-open',
      businessDate: input.businessDate,
      openedAt: new Date('2026-10-20T04:05:00.000Z'),
      openingFloatMinor: 0,
      openedByActorId: 'cashier-2',
      operatingCashierId: null,
    });
    f.db.user.findFirst.mockResolvedValue({ name: 'Bilal' });
    await expect(
      f.caller.drawerStatus({ branchId: 'branch-1', deviceId: 'counter-device' })
    ).resolves.toMatchObject({ operatingCashier: { name: 'Bilal', isYou: false } });
  });

  it('reports no drawer when none is open', async () => {
    const f = fixture();
    await expect(
      f.caller.drawerStatus({ branchId: 'branch-1', deviceId: 'counter-device' })
    ).resolves.toEqual({ openDrawer: null, operatingCashier: null });
  });
});
