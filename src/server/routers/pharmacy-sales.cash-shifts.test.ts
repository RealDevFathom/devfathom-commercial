import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-958B: the cash-shift procedures sit behind the existing counter and drawer-manager gates
// (phase 4 adds separate shift-close and day-close permissions). A cashier opens and closes their
// own shift; naming another cashier is a manager's; an over or short above the tolerance is approved
// through the shared approval path before the close's transaction; a manager's paid-in or paid-out
// goes only into today's drawer.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  recordPharmacyCashMovement: vi.fn(async () => ({ id: 'movement-1' })),
}));
const report = { cash: { expectedMinor: 100 }, varianceMinor: 0 };
vi.mock('@/lib/pharmacy/cash-shifts', () => ({
  openPharmacyCashShift: vi.fn(async () => ({ shift: { id: 'shift-2' }, replayed: false })),
  closePharmacyCashShift: vi.fn(async () => ({
    shift: { id: 'shift-1' },
    report,
    replayed: false,
  })),
  authorizeCashShiftVariance: vi.fn(async () => ({
    shiftId: 'shift-1',
    approverId: 'manager-b',
    policy: 'PHARMACY_SHIFT_VARIANCE_MANAGER_PIN',
    selfApproved: false,
  })),
  readPharmacyCashShiftReport: vi.fn(async () => ({ ...report, status: 'OPEN' })),
  readPharmacyCashShiftPolicy: vi.fn(async () => ({ enabled: true, toleranceMinor: 0 })),
  readPharmacyDrawerShift: vi.fn(async () => ({ openShift: null, lastClosedShift: null })),
  organizationCurrency: vi.fn(async () => 'PKR'),
  shiftVarianceApprovers: vi.fn(async () => []),
}));

import {
  authorizeCashShiftVariance,
  closePharmacyCashShift,
  openPharmacyCashShift,
  readPharmacyCashShiftReport,
} from '@/lib/pharmacy/cash-shifts';
import { recordPharmacyCashMovement } from '@/lib/pharmacy/settlement';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const COUNTER: Rule = { capability: 'pharmacy:counter', effect: 'ALLOW' };
const MANAGE: Rule = { capability: 'pharmacy:manage', effect: 'ALLOW' };

function fixture(roleRules: Rule[]) {
  const member = {
    status: 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: { permissions: roleRules },
    permissionOverrides: [],
  };
  const db = {
    $queryRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async () => member) },
    pharmacyBranch: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => ({ id }))
      ),
      findFirst: vi.fn(async () => ({ id: 'branch-a', name: 'Counter' })),
    },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => [{ branchId: 'branch-a' }]),
      findFirst: vi.fn(async () => ({ branchId: 'branch-a' })),
    },
    organization: { findUnique: vi.fn(async () => ({ currency: 'PKR' })) },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (inner: typeof db) => Promise<unknown>) => fn(db));
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'cashier-a',
        role: 'EMPLOYEE',
        department: 'COUNTER',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return { db, caller: app.createCaller(context as unknown as TRPCContext).pharmacySales };
}

const SCOPE = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

beforeEach(() => vi.clearAllMocks());

describe('DEV-958B cash shift procedures', () => {
  it('lets a cashier open their own shift with the counter grant', async () => {
    const f = fixture([COUNTER]);
    await expect(
      f.caller.openShift({
        branchId: 'branch-a',
        drawerSessionId: 'drawer-1',
        openingFloatMinor: 500,
      })
    ).resolves.toMatchObject({ shift: { id: 'shift-2' } });
    expect(openPharmacyCashShift).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      expect.objectContaining({ drawerSessionId: 'drawer-1', openingFloatMinor: 500 }),
      { actorIsManager: false }
    );
  });

  it('refuses a cashier naming another cashier for a shift, before any write', async () => {
    const f = fixture([COUNTER]);
    await expect(
      f.caller.openShift({
        branchId: 'branch-a',
        drawerSessionId: 'drawer-1',
        openingFloatMinor: 0,
        cashierId: 'cashier-b',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(openPharmacyCashShift).not.toHaveBeenCalled();
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it('lets a manager name the cashier', async () => {
    const f = fixture([MANAGE, COUNTER]);
    await f.caller.openShift({
      branchId: 'branch-a',
      drawerSessionId: 'drawer-1',
      openingFloatMinor: 0,
      cashierId: 'cashier-b',
    });
    expect(openPharmacyCashShift).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      expect.objectContaining({ cashierId: 'cashier-b' }),
      { actorIsManager: true }
    );
  });

  it('refuses a member without the counter grant', async () => {
    const f = fixture([]);
    await expect(
      f.caller.closeShift({ branchId: 'branch-a', shiftId: 'shift-1', countedCashMinor: 100 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(closePharmacyCashShift).not.toHaveBeenCalled();
  });

  it("closes a cashier's own shift as a cashier, with no approval asked", async () => {
    const f = fixture([COUNTER]);
    await expect(
      f.caller.closeShift({ branchId: 'branch-a', shiftId: 'shift-1', countedCashMinor: 100 })
    ).resolves.toEqual(report);
    expect(authorizeCashShiftVariance).not.toHaveBeenCalled();
    expect(closePharmacyCashShift).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      { shiftId: 'shift-1', countedCashMinor: 100, varianceNote: undefined },
      { actorIsManager: false, approval: undefined }
    );
  });

  it('verifies a manager approval through the shared path before the close transaction', async () => {
    const f = fixture([COUNTER]);
    const order: string[] = [];
    vi.mocked(authorizeCashShiftVariance).mockImplementationOnce(async () => {
      order.push('approve');
      expect(f.db.$transaction).not.toHaveBeenCalled();
      return {
        shiftId: 'shift-1',
        approverId: 'manager-b',
        policy: 'PHARMACY_SHIFT_VARIANCE_MANAGER_PIN',
        selfApproved: false,
      };
    });
    vi.mocked(closePharmacyCashShift).mockImplementationOnce(async () => {
      order.push('close');
      return { shift: { id: 'shift-1' }, report, replayed: false } as never;
    });
    await f.caller.closeShift({
      branchId: 'branch-a',
      shiftId: 'shift-1',
      countedCashMinor: 50,
      varianceNote: 'Fifty short',
      approval: { approverId: 'manager-b', approverPin: '4826' },
    });
    expect(order).toEqual(['approve', 'close']);
    expect(authorizeCashShiftVariance).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      { shiftId: 'shift-1', approverId: 'manager-b', pin: '4826' },
      { actorIsManager: false }
    );
    expect(closePharmacyCashShift).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      expect.objectContaining({ countedCashMinor: 50 }),
      expect.objectContaining({ approval: expect.objectContaining({ approverId: 'manager-b' }) })
    );
  });

  it('answers a refused approval as a typed refusal, and closes nothing', async () => {
    const f = fixture([COUNTER]);
    const { PharmacySettlementError } = await import('@/lib/pharmacy/settlement');
    vi.mocked(authorizeCashShiftVariance).mockRejectedValueOnce(
      new PharmacySettlementError('SHIFT_APPROVAL_REQUIRED')
    );
    await expect(
      f.caller.closeShift({
        branchId: 'branch-a',
        shiftId: 'shift-1',
        countedCashMinor: 50,
        varianceNote: 'Short',
        approval: { approverId: 'manager-b', approverPin: '0000' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'SHIFT_APPROVAL_REQUIRED' });
    expect(closePharmacyCashShift).not.toHaveBeenCalled();
  });

  it('lets a manager without the counter grant close and read any shift of the branch', async () => {
    const f = fixture([MANAGE]);
    await f.caller.closeShift({ branchId: 'branch-a', shiftId: 'shift-1', countedCashMinor: 100 });
    expect(closePharmacyCashShift).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      expect.objectContaining({ shiftId: 'shift-1' }),
      { actorIsManager: true, approval: undefined }
    );
    await expect(
      f.caller.shiftReport({ branchId: 'branch-a', shiftId: 'shift-1' })
    ).resolves.toMatchObject({ report: { status: 'OPEN' } });
    expect(readPharmacyCashShiftReport).toHaveBeenCalledWith(expect.anything(), SCOPE, 'shift-1', {
      actorIsManager: true,
    });
  });

  it('keeps a cashier to their own shift: the counter gate, never the manager path', async () => {
    const f = fixture([COUNTER]);
    await f.caller.shiftReport({ branchId: 'branch-a', shiftId: 'shift-1' });
    expect(readPharmacyCashShiftReport).toHaveBeenCalledWith(expect.anything(), SCOPE, 'shift-1', {
      actorIsManager: false,
    });
  });

  it("books a manager's paid-in only on today's drawer", async () => {
    const f = fixture([MANAGE, COUNTER]);
    await f.caller.drawerMovement({
      branchId: 'branch-a',
      drawerSessionId: 'drawer-1',
      kind: 'PAID_IN',
      amountMinor: 500,
      reason: 'Change',
    });
    expect(recordPharmacyCashMovement).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE,
      expect.objectContaining({ requireCurrentBusinessDate: true }),
      { kind: 'COUNTER', actorIsManager: true }
    );
  });
});
