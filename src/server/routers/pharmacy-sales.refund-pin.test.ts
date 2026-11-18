import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-647: refunds need a manager or owner who re-enters their own PIN. Cashiers cannot start one.
// DEV-879: these fixtures model an approver with no approval authenticator, so the PIN is
// checked exactly as before. approval-authenticator.test.ts covers the authenticator path.
vi.mock('@/lib/approval-authenticator', async () => {
  const { verifyOperatorCredential } = await import('@/lib/restaurant/operator-credentials');
  return {
    verifyApprovalSecret: async (
      _db: unknown,
      input: { secret: string; credentialHash: string }
    ) =>
      (await verifyOperatorCredential('PIN', input.secret, input.credentialHash)) ? 'PIN' : null,
  };
});
vi.mock('server-only', () => ({}));
const tenant = vi.hoisted(() => ({ db: null as unknown }));
// The PIN check runs in its own tenant transaction; here it sees the fixture's database.
vi.mock('@/lib/tenancy/scoped-db', () => ({
  createTenantDb: vi.fn(),
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => unknown) =>
    run(tenant.db)
  ),
}));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  refundPharmacyTender: vi.fn(),
}));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  returnSaleLine: vi.fn(),
}));

import { refundPharmacyTender } from '@/lib/pharmacy/settlement';
import { returnSaleLine } from '@/lib/pharmacy/sales';
import {
  REFUND_PIN_BLOCKED,
  REFUND_PIN_POLICY,
  RETURN_PIN_BLOCKED,
} from '@/lib/pharmacy/refund-authorization';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const app = router({ pharmacySales: pharmacySalesRouter });
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Capabilities as the pharmacy role templates grant them (vertical-catalog).
const ROLES: Record<string, Rule[]> = {
  cashier: [
    { capability: 'pharmacy:counter', effect: 'ALLOW' },
    { capability: 'pharmacy:orders', effect: 'ALLOW' },
  ],
  pharmacist: [
    { capability: 'pharmacy:dispense', effect: 'ALLOW' },
    { capability: 'pharmacy:close', effect: 'ALLOW' },
  ],
  manager: [
    { capability: 'pharmacy:counter', effect: 'ALLOW' },
    { capability: 'pharmacy:manage', effect: 'ALLOW' },
  ],
  owner: [{ capability: 'pharmacy:*', effect: 'ALLOW' }],
  admin: [{ capability: '*', effect: 'ALLOW' }],
};

const PIN = '7391';
let pinHash = '';
beforeAll(async () => {
  pinHash = await hashOperatorCredential('PIN', PIN);
});

const settlement = {
  branchId: 'branch-a',
  originalTenderId: 'tender-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-11-14T00:00:00.000Z'),
  amountMinor: 500,
  reason: 'Returned medicine',
  idempotencyKey: 'refund-a',
};

function fixture(
  rules: Rule[],
  credential: { lockedUntil?: Date | null; failedAttempts?: number } | null = {}
) {
  const db = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        status: 'ACTIVE',
        organizationId: 'org-a',
        organizationRole: { permissions: rules },
        permissionOverrides: [],
      }),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-a' }]) },
    pharmacyTender: { findFirst: vi.fn().mockResolvedValue({ type: 'CASH' }) },
    // DEV-501: the recorded return's priced rows: PKR 6.00 gross less PKR 1.00 discount.
    pharmacySaleReturnLine: {
      findMany: vi.fn().mockResolvedValue([{ grossMinor: 600, discountMinor: 100 }]),
    },
    pharmacyUnidentifiedReturnHold: { findMany: vi.fn().mockResolvedValue([]) },
    pharmacySaleLine: { findFirst: vi.fn().mockResolvedValue({ saleId: 'sale-a' }) },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue(
        credential && {
          id: 'credential-a',
          credentialHash: pinHash,
          failedAttempts: credential.failedAttempts ?? 0,
          lockedUntil: credential.lockedUntil ?? null,
        }
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
  };
  tenant.db = db;
  const audit = { detail: {} as { metadata?: Record<string, unknown> } };
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit,
  } as unknown as TRPCContext;
  return { db, audit, caller: app.createCaller(context).pharmacySales };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(refundPharmacyTender).mockResolvedValue({ refundId: 'refund-1' } as never);
  vi.mocked(returnSaleLine).mockResolvedValue({ returnLineId: 'return-line-1' } as never);
});

describe('DEV-647 refunds need a manager or owner PIN', () => {
  it.each(['cashier', 'pharmacist'])('refuses a %s before any PIN or money work', async (role) => {
    const f = fixture(ROLES[role]!);
    await expect(f.caller.refundTender({ ...settlement, managerPin: PIN })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a manager or owner can refund.',
    });
    expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
    expect(f.db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('refuses a manager whose role carries an explicit pharmacy:manage DENY', async () => {
    const f = fixture([
      ...ROLES.manager!.filter((rule) => rule.capability !== 'pharmacy:manage'),
      { capability: 'pharmacy:*', effect: 'ALLOW' },
      { capability: 'pharmacy:manage', effect: 'DENY' },
    ]);
    await expect(f.caller.refundTender({ ...settlement, managerPin: PIN })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('requires the PIN field', async () => {
    const f = fixture(ROLES.manager!);
    await expect(f.caller.refundTender(settlement as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(f.caller.refundTender({ ...settlement, managerPin: '12' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it.each(['manager', 'owner', 'admin'])(
    'lets a %s refund with their own fresh PIN, without passing the PIN on',
    async (role) => {
      const f = fixture(ROLES[role]!);
      await expect(
        f.caller.refundTender({ ...settlement, managerPin: PIN })
      ).resolves.toMatchObject({ refundId: 'refund-1' });
      expect(refundPharmacyTender).toHaveBeenCalledExactlyOnceWith(
        f.db,
        { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' },
        settlement,
        // DEV-821: a refund is a manager's, so any open till of the branch may pay it out.
        {
          requireCurrentBusinessDate: true,
          drawerOperator: { kind: 'COUNTER', actorIsManager: true },
        }
      );
      // The credential is the signed-in user's own PIN.
      expect(f.db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: 'org-a',
            type: 'PIN',
            revokedAt: null,
            staffProfile: expect.objectContaining({ userId: 'user-a', status: 'ACTIVE' }),
          }),
        })
      );
      expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
        where: { id: 'credential-a' },
        data: { failedAttempts: 0, lockedUntil: null },
      });
      expect(f.audit.detail.metadata).toMatchObject({
        policy: REFUND_PIN_POLICY,
        approverId: 'user-a',
        pinVerified: true,
        // DEV-32: the manager or owner who started it approved it with their own PIN.
        initiatedById: 'user-a',
        selfApproved: true,
        approvedAt: expect.stringMatching(ISO_TIME),
      });
      expect(f.db.auditLog.create).not.toHaveBeenCalled();
    }
  );

  it('blocks a wrong PIN, records the strike, and moves no money', async () => {
    const f = fixture(ROLES.owner!);
    await expect(f.caller.refundTender({ ...settlement, managerPin: '8642' })).resolves.toEqual({
      blocked: REFUND_PIN_BLOCKED,
    });
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-a' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
    expect(f.db.pharmacyTender.findFirst).not.toHaveBeenCalled();
    expect(f.audit.detail.metadata).toMatchObject({
      policy: REFUND_PIN_POLICY,
      pinVerified: false,
      // DEV-32: a refused PIN is never recorded as an approval.
      selfApproved: false,
      approvedAt: null,
    });
    // The request audit sees a blocked (successful) call, so the refusal has its own row.
    expect(f.db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        actorId: 'user-a',
        action: 'pharmacySales.refundTender',
        outcome: 'FAILURE',
        errorCode: 'REFUND_PIN_REFUSED',
      }),
    });
  });

  it('checks the PIN in its own tenant transaction so a batch rollback keeps the strike', async () => {
    const f = fixture(ROLES.manager!);
    await f.caller.refundTender({ ...settlement, managerPin: '8642' });
    expect(withTenantDb).toHaveBeenCalledExactlyOnceWith('org-a', expect.any(Function), {
      skipDrain: true,
    });
    // The request transaction is never opened for a refused PIN.
    expect(f.db.$transaction).not.toHaveBeenCalled();
  });

  it('blocks a locked-out PIN even when it is correct', async () => {
    const f = fixture(ROLES.manager!, {
      failedAttempts: 5,
      lockedUntil: new Date(Date.now() + 60_000),
    });
    await expect(f.caller.refundTender({ ...settlement, managerPin: PIN })).resolves.toEqual({
      blocked: REFUND_PIN_BLOCKED,
    });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('blocks a manager who has no active staff PIN', async () => {
    const f = fixture(ROLES.manager!, null);
    await expect(f.caller.refundTender({ ...settlement, managerPin: PIN })).resolves.toEqual({
      blocked: REFUND_PIN_BLOCKED,
    });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });
});

const saleReturn = {
  branchId: 'branch-a',
  saleLineId: 'line-a',
  lotId: 'lot-a',
  canonicalUnits: 2,
  disposition: 'RESTOCK' as const,
  reason: 'WRONG_ITEM',
  integrityDecision: 'Sealed pack, batch verified',
  idempotencyKey: 'return-a',
};

describe('DEV-621 returns need a manager or owner PIN', () => {
  it.each(['cashier', 'pharmacist'])(
    'refuses a %s before any PIN, stock or journal work',
    async (role) => {
      const f = fixture(ROLES[role]!);
      await expect(f.caller.returnLine({ ...saleReturn, managerPin: PIN })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'Only a manager or owner can record a return.',
      });
      expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(returnSaleLine).not.toHaveBeenCalled();
    }
  );

  it('requires the PIN field', async () => {
    const f = fixture(ROLES.manager!);
    await expect(f.caller.returnLine(saleReturn as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(f.caller.returnLine({ ...saleReturn, managerPin: '12' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(returnSaleLine).not.toHaveBeenCalled();
  });

  it.each(['manager', 'owner', 'admin'])(
    'lets a %s record a return with their own fresh PIN, without passing the PIN on',
    async (role) => {
      const f = fixture(ROLES[role]!);
      await expect(f.caller.returnLine({ ...saleReturn, managerPin: PIN })).resolves.toMatchObject({
        returnLineId: 'return-line-1',
      });
      expect(returnSaleLine).toHaveBeenCalledExactlyOnceWith(
        f.db,
        { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' },
        saleReturn
      );
      expect(f.db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            staffProfile: expect.objectContaining({ userId: 'user-a', status: 'ACTIVE' }),
          }),
        })
      );
      expect(f.audit.detail.metadata).toMatchObject({
        policy: REFUND_PIN_POLICY,
        approverId: 'user-a',
        pinVerified: true,
        // DEV-32: the manager or owner who started it approved it with their own PIN.
        initiatedById: 'user-a',
        selfApproved: true,
        approvedAt: expect.stringMatching(ISO_TIME),
      });
    }
  );

  it('blocks a wrong PIN, records the strike and the refusal, and moves no stock', async () => {
    const f = fixture(ROLES.owner!);
    await expect(f.caller.returnLine({ ...saleReturn, managerPin: '8642' })).resolves.toEqual({
      blocked: RETURN_PIN_BLOCKED,
    });
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-a' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
    expect(f.db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        actorId: 'user-a',
        action: 'pharmacySales.returnLine',
        outcome: 'FAILURE',
        errorCode: 'REFUND_PIN_REFUSED',
      }),
    });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(returnSaleLine).not.toHaveBeenCalled();
  });
});

const returnAndRefund = {
  ...saleReturn,
  refund: {
    originalTenderId: 'tender-a',
    deviceId: 'device-a',
    businessDate: new Date('2026-11-14T00:00:00.000Z'),
  },
};

describe('DEV-732 return input requires explicit choices', () => {
  it.each(['returnLine', 'returnAndRefund'] as const)(
    '%s rejects missing, blank or invalid choices before PIN, stock or money work',
    async (endpoint) => {
      const f = fixture(ROLES.manager!);
      for (const [field, value] of [
        ['reason', undefined],
        ['reason', '   '],
        ['disposition', undefined],
        ['disposition', ''],
        ['disposition', 'AVAILABLE'],
      ] as const) {
        const input = { ...returnAndRefund, managerPin: PIN, [field]: value };
        if (endpoint === 'returnLine') delete (input as { refund?: unknown }).refund;
        await expect(f.caller[endpoint](input as never)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
        });
        expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
        expect(f.db.$transaction).not.toHaveBeenCalled();
        expect(returnSaleLine).not.toHaveBeenCalled();
        expect(refundPharmacyTender).not.toHaveBeenCalled();
      }
    }
  );
});

describe('DEV-501 one confirm records the return and refunds it', () => {
  beforeEach(() => {
    vi.mocked(returnSaleLine).mockResolvedValue({ returnId: 'return-1', replayed: false } as never);
    vi.mocked(refundPharmacyTender).mockResolvedValue({
      refundId: 'refund-1',
      amountMinor: 500,
    } as never);
  });

  it.each(['cashier', 'pharmacist'])(
    'refuses a %s before any PIN, stock or money work',
    async (role) => {
      const f = fixture(ROLES[role]!);
      await expect(
        f.caller.returnAndRefund({ ...returnAndRefund, managerPin: PIN })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(f.db.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
      expect(f.db.$transaction).not.toHaveBeenCalled();
      expect(returnSaleLine).not.toHaveBeenCalled();
      expect(refundPharmacyTender).not.toHaveBeenCalled();
    }
  );

  it('requires the PIN field', async () => {
    const f = fixture(ROLES.manager!);
    await expect(f.caller.returnAndRefund(returnAndRefund as never)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(returnSaleLine).not.toHaveBeenCalled();
  });

  it('blocks a wrong PIN with its own refusal row and records nothing', async () => {
    const f = fixture(ROLES.owner!);
    await expect(
      f.caller.returnAndRefund({ ...returnAndRefund, managerPin: '8642' })
    ).resolves.toEqual({ blocked: RETURN_PIN_BLOCKED });
    expect(f.db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-a' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
    expect(f.db.auditLog.create).toHaveBeenCalledExactlyOnceWith({
      data: expect.objectContaining({
        action: 'pharmacySales.returnAndRefund',
        outcome: 'FAILURE',
        errorCode: 'REFUND_PIN_REFUSED',
      }),
    });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(returnSaleLine).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it.each(['manager', 'owner', 'admin'])(
    'lets a %s (a solo owner included) return and refund the exact value with one PIN',
    async (role) => {
      const f = fixture(ROLES[role]!);
      await expect(
        f.caller.returnAndRefund({ ...returnAndRefund, managerPin: PIN })
      ).resolves.toEqual({
        returnId: 'return-1',
        returnedMinor: 500,
        refund: { refundId: 'refund-1', amountMinor: 500 },
        replayed: false,
      });
      const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'user-a' };
      // One transaction: the return, then the refund of that return's own value.
      expect(f.db.$transaction).toHaveBeenCalledOnce();
      expect(returnSaleLine).toHaveBeenCalledExactlyOnceWith(f.db, scope, saleReturn);
      expect(f.db.pharmacySaleReturnLine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: 'org-a', branchId: 'branch-a', returnId: 'return-1' },
        })
      );
      expect(refundPharmacyTender).toHaveBeenCalledExactlyOnceWith(
        f.db,
        scope,
        {
          ...returnAndRefund.refund,
          amountMinor: 500,
          reason: 'WRONG_ITEM',
          idempotencyKey: 'return-a:refund',
        },
        // DEV-821: the manager's PIN-approved refund may come out of any open till of
        // the branch, a colleague's included (the resolver's own suite proves the till).
        {
          requireCurrentBusinessDate: true,
          drawerOperator: { kind: 'COUNTER', actorIsManager: true },
        }
      );
      expect(vi.mocked(returnSaleLine).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(refundPharmacyTender).mock.invocationCallOrder[0]!
      );
      // The PIN is checked once and never passed on.
      expect(f.db.restaurantOperatorCredential.findFirst).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(refundPharmacyTender).mock.calls)).not.toContain(PIN);
      expect(f.audit.detail.metadata).toMatchObject({
        policy: REFUND_PIN_POLICY,
        approverId: 'user-a',
        pinVerified: true,
        // DEV-32: the manager or owner who started it approved it with their own PIN.
        initiatedById: 'user-a',
        selfApproved: true,
        approvedAt: expect.stringMatching(ISO_TIME),
      });
    }
  );

  it('refuses a tender from another receipt before recording the return', async () => {
    const f = fixture(ROLES.owner!);
    // The tender is not on the returned line's sale.
    f.db.pharmacyTender.findFirst.mockResolvedValueOnce(null);
    await expect(
      f.caller.returnAndRefund({ ...returnAndRefund, managerPin: PIN })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Refund the return to a tender from the same receipt.',
    });
    expect(f.db.pharmacySaleLine.findFirst).toHaveBeenCalledWith({
      where: { id: 'line-a', organizationId: 'org-a', branchId: 'branch-a' },
      select: { saleId: true },
    });
    expect(f.db.pharmacyTender.findFirst).toHaveBeenCalledWith({
      where: { id: 'tender-a', organizationId: 'org-a', branchId: 'branch-a', saleId: 'sale-a' },
      select: { id: true },
    });
    expect(returnSaleLine).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('refunds a lowered amount and refuses more than the return is worth', async () => {
    const f = fixture(ROLES.manager!);
    await f.caller.returnAndRefund({
      ...returnAndRefund,
      refund: { ...returnAndRefund.refund, amountMinor: 350, manualCashFallback: true },
      managerPin: PIN,
    });
    expect(refundPharmacyTender).toHaveBeenCalledWith(
      f.db,
      expect.anything(),
      expect.objectContaining({ amountMinor: 350, manualCashFallback: true }),
      { requireCurrentBusinessDate: true, drawerOperator: { kind: 'COUNTER', actorIsManager: true } }
    );
    vi.mocked(refundPharmacyTender).mockClear();
    await expect(
      f.caller.returnAndRefund({
        ...returnAndRefund,
        refund: { ...returnAndRefund.refund, amountMinor: 501 },
        managerPin: PIN,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'REFUND_EXCEEDS_TENDER' });
    // The transaction throws, so the return it recorded rolls back with it.
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('refuses a refund when the return cannot be valued', async () => {
    const f = fixture(ROLES.manager!);
    f.db.pharmacySaleReturnLine.findMany.mockResolvedValue([
      { grossMinor: null, discountMinor: null },
    ]);
    await expect(
      f.caller.returnAndRefund({ ...returnAndRefund, managerPin: PIN })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'INVALID_STATE' });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('propagates a refused refund so the return rolls back with it', async () => {
    const f = fixture(ROLES.manager!);
    vi.mocked(refundPharmacyTender).mockRejectedValueOnce(new Error('DRAWER_NOT_OPEN'));
    await expect(
      f.caller.returnAndRefund({ ...returnAndRefund, managerPin: PIN })
    ).rejects.toThrow();
    expect(returnSaleLine).toHaveBeenCalledOnce();
  });
});

describe('DEV-647 refund entry visibility', () => {
  it.each([
    ['cashier', false],
    ['pharmacist', false],
    ['manager', true],
    ['owner', true],
    ['admin', true],
  ] as const)('reports refund access for a %s as %s', async (role, authorized) => {
    await expect(fixture(ROLES[role]!).caller.refundAccess()).resolves.toEqual({ authorized });
  });
});
