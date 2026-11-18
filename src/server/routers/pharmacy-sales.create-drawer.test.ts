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
import { PHARMACY_ROLE_TEMPLATES } from '@/lib/vertical-catalog';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const COUNTER: Rule[] = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }];

function fixture(openDrawer: { id: string; businessDate: Date } | null, permissions = COUNTER) {
  const db = {
    // DEV-631: a counter bill or line is refused while today's business day is closed.
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    // DEV-607: create takes the counter gate (member, pharmacy:counter, branch assignment).
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions },
        permissionOverrides: [],
      }),
    },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-1' })),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-1' }]),
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

const drawer = { id: 'drawer-1', businessDate: new Date('2026-11-15T00:00:00.000Z') };

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
    const f = fixture(drawer);
    await expect(f.caller.create({ branchId: 'branch-1', quotation: false })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    await expect(f.caller.create({ branchId: 'branch-1' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });

  it('starts the bill once this device has an OPEN drawer', async () => {
    const f = fixture(drawer);
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

  it('re-checks the drawer under its business-day lock, so a close that wins the race refuses the bill', async () => {
    const f = fixture(drawer);
    // OPEN when first read; CLOSED once the day lock is held (the close committed first).
    f.db.pharmacyDrawerSession.findFirst.mockResolvedValueOnce(drawer).mockResolvedValueOnce(null);
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DRAWER_NOT_OPEN' });
    // The lock is the one drawer and day close take: org, branch and the drawer's business day.
    const locks = f.db.$queryRaw.mock.calls
      .map(([sql]) => sql as { strings?: readonly string[]; values?: unknown[] })
      .filter((sql) => sql.strings?.join('?').includes('pg_advisory_xact_lock'));
    expect(locks.map((sql) => sql.values)).toContainEqual(['org-1:branch-1:2026-11-15']);
    expect(f.db.pharmacyDrawerSession.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'drawer-1', organizationId: 'org-1', branchId: 'branch-1', status: 'OPEN' },
      select: { id: true },
    });
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });

  it('keeps quotations free of the drawer: they take no payment', async () => {
    const f = fixture(null);
    await expect(f.caller.create({ branchId: 'branch-1', quotation: true })).resolves.toMatchObject(
      { status: 'QUOTATION' }
    );
    expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
  });

  it("DEV-631: refuses a counter bill while today's business day is closed, before any bill is written", async () => {
    const f = fixture(drawer);
    f.db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1', reopen: null });
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DAY_CLOSED' });
    // Today in the workspace zone, read for the scope's organization.
    expect(f.db.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      select: { timezone: true },
    });
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
    expect(f.db.pharmacySaleEvent.create).not.toHaveBeenCalled();
  });

  it('DEV-631: starts the bill again once the owner reopened the day for trading', async () => {
    const f = fixture(drawer);
    f.db.pharmacyDailyClose.findFirst.mockResolvedValue({ id: 'close-1', reopen: { id: 'r-1' } });
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).resolves.toMatchObject({ id: 'sale-new', status: 'OPEN' });
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

// DEV-97: only someone who takes payment opens a drawer. A pharmacist (dispense,
// no `pharmacy:counter`) builds the bill and counter staff take the payment, so
// the DEV-725 drawer gate applies to the operators who can settle it.
describe('pharmacySales.create drawer gate follows the settlement grant (DEV-97)', () => {
  const PHARMACIST: Rule[] = [{ capability: 'pharmacy:dispense', effect: 'ALLOW' }];

  it('lets a pharmacist without pharmacy:counter start a bill on a device with no OPEN drawer', async () => {
    const f = fixture(null, PHARMACIST);
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).resolves.toMatchObject({ id: 'sale-new', status: 'OPEN' });
    expect(f.db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
    expect(f.db.pharmacySale.create).toHaveBeenCalledOnce();
  });

  it('keeps the drawer gate for a pharmacist who also takes payment', async () => {
    // A pharmacist an owner granted pharmacy:counter opens the drawer first, like a cashier.
    const f = fixture(null, [...PHARMACIST, ...COUNTER]);
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DRAWER_NOT_OPEN' });
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });

  it('keeps the drawer step for the opt-in Pharmacist and cashier role (DEV-622)', async () => {
    const role = PHARMACY_ROLE_TEMPLATES.find((template) => template.key === 'pharmacist-cashier')!;
    const f = fixture(
      null,
      role.capabilities.map((capability) => ({ capability, effect: 'ALLOW' as const }))
    );
    await expect(
      f.caller.create({ branchId: 'branch-1', quotation: false, deviceId: 'counter-device' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'DRAWER_NOT_OPEN' });
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });

  it('still requires the counter device for a pharmacist bill', async () => {
    const f = fixture(null, PHARMACIST);
    await expect(f.caller.create({ branchId: 'branch-1', quotation: false })).rejects.toMatchObject(
      { code: 'BAD_REQUEST' }
    );
    expect(f.db.pharmacySale.create).not.toHaveBeenCalled();
  });
});
