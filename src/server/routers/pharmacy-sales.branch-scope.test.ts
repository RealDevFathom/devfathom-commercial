import { beforeEach, describe, expect, it, vi } from 'vitest';

// The drawer and close family, and the tender and refund that move cash through
// the same drawer, take their branch from the input. `scopeFor` refuses a branch
// that is not an active pharmacy branch of the caller's organization (one
// `assertInOrganization` lookup); the counter's cash tender reaches it through
// `branchScopeOrForbidden`, which words that refusal as a scope denial. Every one
// of these nine procedures must refuse such a branch before the settlement
// library takes a lock, reads a drawer or writes anything. The close procedures
// keep their day-close capability gate in front of that check; opening a drawer
// requires the canonical counter capability.
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

import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Caller = ReturnType<typeof app.createCaller>['pharmacySales'];
type Refusal = { code: string; message: string };

const BRANCH = 'branch-elsewhere';
const businessDate = new Date('2026-10-20T00:00:00.000Z');
/** `scopeFor`'s refusal. */
const NOT_IN_WORKSPACE: Refusal = {
  code: 'BAD_REQUEST',
  message: 'That record is not in this workspace.',
};
/** The same refusal, as the counter's receipt-access path words it. */
const OUTSIDE: Refusal = { code: 'FORBIDDEN', message: 'Branch is outside your scope.' };

const memberWithoutCustomRules = { organizationRole: null, permissionOverrides: [] };

const procedures: Array<[string, (caller: Caller) => Promise<unknown>, Refusal]> = [
  ['manualPaymentSettings', (c) => c.manualPaymentSettings({ branchId: BRANCH }), OUTSIDE],
  [
    'saveManualPaymentSettings',
    (c) => {
      // `adminProcedure` asks ABAC for `admin:access`; a user row with no custom
      // rules lets the session ADMIN reach the branch scope check.
      db.user.findUnique.mockResolvedValue(memberWithoutCustomRules);
      return c.saveManualPaymentSettings({ branchId: BRANCH, revision: 0, settings: {} });
    },
    OUTSIDE,
  ],
  [
    'drawerStatus',
    (c) => c.drawerStatus({ branchId: BRANCH, deviceId: 'counter-device' }),
    NOT_IN_WORKSPACE,
  ],
  [
    'openDrawer',
    (c) =>
      c.openDrawer({
        branchId: BRANCH,
        deviceId: 'counter-device',
        businessDate,
        openingFloatMinor: 500,
      }),
    NOT_IN_WORKSPACE,
  ],
  [
    'drawerMovement',
    (c) =>
      c.drawerMovement({
        branchId: BRANCH,
        drawerSessionId: 'drawer-1',
        kind: 'PAID_IN',
        amountMinor: 100,
        reason: 'Float top-up',
      }),
    NOT_IN_WORKSPACE,
  ],
  [
    'closeDrawer',
    (c) => c.closeDrawer({ branchId: BRANCH, drawerSessionId: 'drawer-1', countedCashMinor: 0 }),
    NOT_IN_WORKSPACE,
  ],
  ['dailyClose', (c) => c.dailyClose({ branchId: BRANCH, businessDate }), NOT_IN_WORKSPACE],
  ['closePreview', (c) => c.closePreview({ branchId: BRANCH, businessDate }), NOT_IN_WORKSPACE],
  [
    'closeDay',
    (c) =>
      c.closeDay({
        branchId: BRANCH,
        businessDate,
        sourceHash: 'a'.repeat(64),
        counts: [],
        varianceNote: '',
      }),
    NOT_IN_WORKSPACE,
  ],
  [
    'tender',
    (c) =>
      c.tender({
        branchId: BRANCH,
        saleId: 'sale-1',
        deviceId: 'counter-device',
        businessDate,
        type: 'CASH',
        amountMinor: 500,
        cashReceivedMinor: 500,
        idempotencyKey: 'tender-1',
      }),
    OUTSIDE,
  ],
  [
    'refundTender',
    (c) =>
      c.refundTender({
        branchId: BRANCH,
        originalTenderId: 'tender-1',
        deviceId: 'counter-device',
        businessDate,
        amountMinor: 500,
        reason: 'Returned medicine',
        idempotencyKey: 'refund-1',
      }),
    OUTSIDE,
  ],
];
const closeProcedures = procedures.filter(([name]) =>
  ['dailyClose', 'closePreview', 'closeDay'].includes(name)
);

let db: {
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
  pharmacyBranch: { findMany: ReturnType<typeof vi.fn> };
  pharmacyDailyClose: { findFirst: ReturnType<typeof vi.fn> };
  pharmacyDrawerSession: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  pharmacyDrawerMovement: { create: ReturnType<typeof vi.fn> };
  pharmacyTender: { findFirst: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
};

function caller(role = 'ADMIN'): Caller {
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role, status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacySales;
}

beforeEach(() => {
  db = {
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(0),
    // Unknown, inactive and another tenant's branch all read as "no such active branch".
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacyDailyClose: { findFirst: vi.fn().mockResolvedValue(null) },
    pharmacyDrawerSession: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'drawer-new', status: 'OPEN' }),
    },
    pharmacyDrawerMovement: { create: vi.fn().mockResolvedValue({}) },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue(null) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:counter', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      }),
    },
  };
});

describe('pharmacy drawer, close and cash procedures: the branch in the input', () => {
  it('refuses non-admin changes to reference-skip policy before accessing the branch', async () => {
    // A real member row, so the refusal is the ADMIN policy, not a missing user.
    db.user.findUnique.mockResolvedValue(memberWithoutCustomRules);
    await expect(caller('EMPLOYEE').saveManualPaymentSettings({ branchId: BRANCH, revision: 0, settings: {
      RAAST: { destination: 'Till', allowReferenceSkip: true },
    } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
  });
  it.each(procedures)(
    '%s refuses a branch that is not an active branch of the organization, touching nothing',
    async (_name, run, refusal) => {
      await expect(run(caller())).rejects.toMatchObject(refusal);
      expect(db.pharmacyBranch.findMany).toHaveBeenCalledExactlyOnceWith({
        where: { id: { in: [BRANCH] }, organizationId: 'org-1', active: true },
        select: { id: true },
      });
      // No day lock, no day, drawer or tender read, no write.
      expect(db.$queryRaw).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.pharmacyDailyClose.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerSession.findFirst).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerSession.create).not.toHaveBeenCalled();
      expect(db.pharmacyDrawerMovement.create).not.toHaveBeenCalled();
      expect(db.pharmacyTender.findFirst).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s keeps the day-close capability gate in front of the branch check',
    async (_name, run) => {
      await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Day-close permission is required to reconcile and close a day.',
      });
      expect(db.pharmacyBranch.findMany).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    }
  );

  it.each(closeProcedures)(
    '%s lets a non-admin with pharmacy:close reach the normal branch scope check',
    async (_name, run, refusal) => {
      db.user.findUnique.mockResolvedValue({
        organizationRole: {
          permissions: [{ capability: 'pharmacy:close', effect: 'ALLOW' }],
        },
        permissionOverrides: [],
      });
      await expect(run(caller('EMPLOYEE'))).rejects.toMatchObject(refusal);
      expect(db.pharmacyBranch.findMany).toHaveBeenCalledOnce();
    }
  );

  it('opens a drawer on an active branch of the organization, scoped to that branch', async () => {
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
    await expect(
      caller('EMPLOYEE').openDrawer({
        branchId: BRANCH,
        deviceId: 'counter-device',
        businessDate,
        openingFloatMinor: 0,
      })
    ).resolves.toMatchObject({ id: 'drawer-new' });
    expect(db.pharmacyDrawerSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        branchId: BRANCH,
        openedByActorId: 'actor-1',
      }),
    });
  });
});
