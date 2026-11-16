import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-631: closing a day early must not block selling until midnight. The owner or
// a manager reopens today's closed day for trading, with a reason and a fresh
// re-authentication (their own staff PIN); a cashier is refused. The counter learns
// the day is closed from its drawer status before a bill is built.
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
  // The engine's coarse answer; the member's own stored rules decide below (deny wins).
  can: vi.fn(async () => true),
}));
vi.mock('@/lib/pharmacy/day-reopen-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/day-reopen-authorization')>()),
  authenticateDayReopenPin: vi.fn(async () => ({ verified: true })),
}));
vi.mock('@/lib/pharmacy/day-close', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/day-close')>()),
  reopenPharmacyDayForTrading: vi.fn(async () => ({ id: 'reopen-1', closeId: 'close-1' })),
}));

import { can } from '@/lib/abac';
import { reopenPharmacyDayForTrading } from '@/lib/pharmacy/day-close';
import {
  authenticateDayReopenPin,
  DAY_REOPEN_PIN_BLOCKED,
  DAY_REOPEN_PIN_POLICY,
} from '@/lib/pharmacy/day-reopen-authorization';
import { annotateAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const BRANCH = 'branch-1';
const businessDate = new Date('2026-11-02T00:00:00.000Z');
const ownerPin = '4321';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const OWNER: Rule[] = [{ capability: 'pharmacy:*', effect: 'ALLOW' }];
const MANAGER: Rule[] = [
  { capability: 'pharmacy:manage', effect: 'ALLOW' },
  { capability: 'pharmacy:counter', effect: 'ALLOW' },
];
const CASHIER: Rule[] = [{ capability: 'pharmacy:counter', effect: 'ALLOW' }];

function fixture(
  options: {
    role?: 'ADMIN' | 'EMPLOYEE';
    rules?: Rule[];
    overrides?: Rule[];
    assigned?: string[];
  } = {}
) {
  const { role = 'ADMIN', rules = OWNER, overrides = [], assigned = [BRANCH] } = options;
  const db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
    $queryRaw: vi.fn().mockResolvedValue([]),
    organization: { findUnique: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    pharmacyBranch: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: BRANCH })),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => assigned.map((branchId) => ({ branchId }))),
    },
    user: {
      findUnique: vi.fn(async () => ({
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: { permissions: rules },
        permissionOverrides: overrides,
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

const request = {
  closeId: 'close-1',
  branchId: BRANCH,
  businessDate,
  reason: 'Closed early by mistake',
  ownerPin,
};

beforeEach(() => {
  vi.mocked(authenticateDayReopenPin).mockClear().mockResolvedValue({ verified: true });
  vi.mocked(reopenPharmacyDayForTrading).mockClear();
  vi.mocked(annotateAudit).mockClear();
});

describe('pharmacySales.reopenDay', () => {
  it('lets the owner reopen the day with a reason and a fresh PIN, scoped and audited', async () => {
    const { caller } = fixture();
    await expect(caller.reopenDay(request)).resolves.toEqual({
      id: 'reopen-1',
      closeId: 'close-1',
    });
    // The actor's own PIN, re-checked for this action before the reopen is written.
    expect(authenticateDayReopenPin).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org-1',
      actorId: 'user-1',
      pin: ownerPin,
    });
    expect(vi.mocked(authenticateDayReopenPin).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(reopenPharmacyDayForTrading).mock.invocationCallOrder[0]!
    );
    // The PIN never reaches the domain write, which records who, when and why.
    expect(reopenPharmacyDayForTrading).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: BRANCH, actorId: 'user-1' },
      { businessDate, closeId: 'close-1', reason: 'Closed early by mistake' }
    );
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: { policy: DAY_REOPEN_PIN_POLICY, pinVerified: true },
      })
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

  it('lets a manager assigned to the branch reopen with their own fresh PIN', async () => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: MANAGER });
    await expect(caller.reopenDay(request)).resolves.toEqual({
      id: 'reopen-1',
      closeId: 'close-1',
    });
    expect(authenticateDayReopenPin).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org-1',
      actorId: 'user-1',
      pin: ownerPin,
    });
    expect(reopenPharmacyDayForTrading).toHaveBeenCalledWith(
      expect.anything(),
      { organizationId: 'org-1', branchId: BRANCH, actorId: 'user-1' },
      { businessDate, closeId: 'close-1', reason: 'Closed early by mistake' }
    );
  });

  it('refuses a cashier before any PIN check or write', async () => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: CASHIER });
    await expect(caller.reopenDay(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authenticateDayReopenPin).not.toHaveBeenCalled();
    expect(reopenPharmacyDayForTrading).not.toHaveBeenCalled();
  });

  it('refuses a manager whose manage grant is explicitly denied', async () => {
    const { caller } = fixture({
      role: 'EMPLOYEE',
      rules: MANAGER,
      overrides: [{ capability: 'pharmacy:manage', effect: 'DENY' }],
    });
    await expect(caller.reopenDay(request)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(authenticateDayReopenPin).not.toHaveBeenCalled();
    expect(reopenPharmacyDayForTrading).not.toHaveBeenCalled();
  });

  it('refuses a manager on a branch they are not assigned to', async () => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: MANAGER, assigned: ['branch-2'] });
    await expect(caller.reopenDay(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Branch is outside your scope.',
    });
    expect(authenticateDayReopenPin).not.toHaveBeenCalled();
    expect(reopenPharmacyDayForTrading).not.toHaveBeenCalled();
  });

  it('refuses a reopen whose fresh PIN re-authentication fails, and reopens nothing', async () => {
    vi.mocked(authenticateDayReopenPin).mockResolvedValue({ blocked: DAY_REOPEN_PIN_BLOCKED });
    const { caller } = fixture({ role: 'EMPLOYEE', rules: MANAGER });
    await expect(caller.reopenDay({ ...request, ownerPin: '0000' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: DAY_REOPEN_PIN_BLOCKED,
    });
    expect(reopenPharmacyDayForTrading).not.toHaveBeenCalled();
    expect(annotateAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: { policy: DAY_REOPEN_PIN_POLICY, pinVerified: false },
      })
    );
  });

  it.each([
    ['without a fresh PIN', { branchId: BRANCH, businessDate, closeId: 'close-1', reason: 'Why' }],
    ['with a malformed PIN', { ...request, ownerPin: '12' }],
    ['with an empty reason', { ...request, reason: '   ' }],
    [
      'for a business date carrying a time',
      { ...request, businessDate: new Date('2026-11-02T10:00:00Z') },
    ],
  ])('refuses a reopen %s before any check or write', async (_name, input) => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: MANAGER });
    await expect(caller.reopenDay(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(authenticateDayReopenPin).not.toHaveBeenCalled();
    expect(reopenPharmacyDayForTrading).not.toHaveBeenCalled();
  });
});

describe('pharmacySales.dayReopenAccess', () => {
  it('offers the reopen to a holder of pharmacy:manage and to nobody else', async () => {
    const { caller } = fixture({ role: 'EMPLOYEE', rules: MANAGER });
    await expect(caller.dayReopenAccess()).resolves.toEqual({ authorized: true });
    expect(can).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      'pharmacy:manage',
      undefined,
      expect.anything()
    );
    vi.mocked(can).mockResolvedValueOnce(false);
    await expect(caller.dayReopenAccess()).resolves.toEqual({ authorized: false });
  });
});

describe('pharmacySales.tradingDayStatus', () => {
  it.each([true, false])(
    'reports closed=%s from the latest close in the server business day',
    async (closed) => {
      const { db, caller } = fixture({ role: 'EMPLOYEE', rules: CASHIER });
      db.pharmacyDailyClose.findFirst.mockResolvedValue({
        id: 'close-1',
        reopen: closed ? null : { id: 'r-1' },
      });
      const date = new Date().toISOString().slice(0, 10);
      await expect(caller.tradingDayStatus({ branchId: BRANCH })).resolves.toEqual({
        businessDate: date,
        dayClosed: closed,
      });
      expect(db.pharmacyDailyClose.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            organizationId: 'org-1',
            branchId: BRANCH,
            businessDate: new Date(`${date}T00:00:00.000Z`),
          },
          orderBy: { sequence: 'desc' },
        })
      );
    }
  );

  it('refuses a branch outside the active assignment before reading its close', async () => {
    const { db, caller } = fixture({ role: 'EMPLOYEE', rules: CASHIER, assigned: [] });
    await expect(caller.tradingDayStatus({ branchId: BRANCH })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
  });
});
