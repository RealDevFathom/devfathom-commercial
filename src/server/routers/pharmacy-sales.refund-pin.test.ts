import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-647: refunds need a manager or owner who re-enters their own PIN. Cashiers cannot start one.
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

import { refundPharmacyTender } from '@/lib/pharmacy/settlement';
import { REFUND_PIN_BLOCKED, REFUND_PIN_POLICY } from '@/lib/pharmacy/refund-authorization';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const app = router({ pharmacySales: pharmacySalesRouter });

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
        settlement
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

describe('DEV-647 refund entry visibility', () => {
  it.each([
    ['cashier', false],
    ['pharmacist', false],
    ['manager', true],
    ['owner', true],
    ['admin', true],
  ] as const)('reports refund access for a %s as %s', async (role, authorized) => {
    // DEV-645: the fixture's actor has an active staff PIN, so a refunder's PIN is ready.
    await expect(fixture(ROLES[role]!).caller.refundAccess()).resolves.toEqual({
      authorized,
      pinReady: authorized,
    });
  });
});
