import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TRPCContext } from '../trpc';

const mocks = vi.hoisted(() => ({
  branch: vi.fn(),
  solo: vi.fn(),
  pin: vi.fn(),
  refund: vi.fn(),
  returns: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({ hasModule: () => true }));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  isAuditExcludedPath: () => true,
}));
vi.mock('@/lib/pharmacy/branch-assignment', () => ({ assertBranchAssignment: mocks.branch }));
vi.mock('@/lib/pharmacy/solo-approval', () => ({
  authorizeSoloApproval: mocks.solo,
  verifyPharmacyUserPin: mocks.pin,
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  refundPharmacyTender: mocks.refund,
}));
vi.mock('@/lib/pharmacy/sales', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/sales')>()),
  returnSaleLine: mocks.returns,
}));
import { pharmacySalesRouter } from './pharmacy-sales';

function fixture(mode: 'SOLO' | 'STAFFED', maker = 'maker') {
  const db = {
    $queryRaw: vi.fn(async () => []),
    organization: {
      findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: mode })),
      findUniqueOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: mode })),
    },
    user: {
      findFirst: vi.fn(async () => ({ organizationRole: { key: 'manager' } })),
      findMany: vi.fn(async ({ select }) => {
        const record = { id: 'checker', name: 'Checker', email: 'private@example.test' };
        return [Object.fromEntries(Object.entries(record).filter(([key]) => select[key]))];
      }),
    },
    pharmacyBranch: { findMany: vi.fn(async () => [{ id: 'branch' }]) },
    pharmacyTender: {
      findFirst: vi.fn(async () => ({ type: 'CASH', sale: { createdByUserId: maker } })),
    },
    pharmacySaleLine: { findFirst: vi.fn(async () => ({ sale: { createdByUserId: maker } })) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: (run: (db: unknown) => unknown) => run(db),
  };
  const ctx = {
    db,
    session: { user: { id: 'actor', organizationId: 'org', status: 'ACTIVE', role: 'EMPLOYEE' } },
    entitlements: { organizationId: 'org', enabledModules: ['pharmacy-counter'] },
    audit: { detail: {} },
    requestMeta: { ip: null, userAgent: null },
  } as unknown as TRPCContext;
  const caller = pharmacySalesRouter.createCaller(ctx);
  return {
    db,
    caller,
    call: (
      kind: 'RETURN' | 'REFUND',
      approval: { approvalPin?: string; approvedByUserId?: string }
    ) =>
      kind === 'RETURN'
        ? caller.returnLine({
            branchId: 'branch',
            saleLineId: 'line',
            canonicalUnits: 1,
            disposition: 'QUARANTINE',
            quarantineLocationId: 'q',
            reason: 'Damaged',
            integrityDecision: 'Seal broken',
            idempotencyKey: 'return',
            ...approval,
          })
        : caller.refundTender({
            branchId: 'branch',
            originalTenderId: 'tender',
            deviceId: 'device',
            businessDate: new Date(),
            amountMinor: 100,
            reason: 'Returned',
            idempotencyKey: 'refund',
            ...approval,
          }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.branch.mockImplementation(async (_db, scope) => scope);
  mocks.solo.mockImplementation(async (_db, _scope, _target, pin) => pin === '4729');
  mocks.pin.mockImplementation(async (_scope, pin) => pin === '4729');
  mocks.refund.mockResolvedValue({});
  mocks.returns.mockResolvedValue({});
});
describe.each(['RETURN', 'REFUND'] as const)(
  '%s operating approval at the router boundary',
  (kind) => {
    it('requires the SOLO owner credential and delegates atomic audit authorization before domain writes', async () => {
      const { db, call } = fixture('SOLO', 'actor');
      await expect(call(kind, {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(mocks.refund).not.toHaveBeenCalled();
      expect(mocks.returns).not.toHaveBeenCalled();
      await call(kind, { approvalPin: '4729' });
      expect(mocks.solo).toHaveBeenLastCalledWith(
        db,
        expect.objectContaining({ actorId: 'actor' }),
        expect.objectContaining({
          type: kind === 'RETURN' ? 'PharmacySaleLine' : 'PharmacyTender',
        }),
        '4729'
      );
      const domain = kind === 'RETURN' ? mocks.returns : mocks.refund;
      expect(domain.mock.calls[0][2]).not.toHaveProperty('approvalPin');
      expect(domain.mock.calls[0][2]).not.toHaveProperty('approvedByUserId');
    });
    it('requires an independent STAFFED checker, verifies branch and PIN, and writes secret-free audit', async () => {
      const { db, call } = fixture('STAFFED', 'actor');
      await expect(
        call(kind, { approvalPin: '4729', approvedByUserId: 'actor' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        call(kind, { approvalPin: '1111', approvedByUserId: 'checker' })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(db.auditLog.create).not.toHaveBeenCalled();
      await call(kind, { approvalPin: '4729', approvedByUserId: 'checker' });
      expect(mocks.branch).toHaveBeenCalledWith(db, {
        organizationId: 'org',
        branchId: 'branch',
        actorId: 'checker',
      });
      expect(db.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actorId: 'checker', action: `PHARMACY:STAFFED:${kind}` }),
        })
      );
      expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('4729');
      const domain = kind === 'RETURN' ? mocks.returns : mocks.refund;
      expect(domain).toHaveBeenCalledOnce();
      expect(domain.mock.calls[0][2]).not.toHaveProperty('approvalPin');
    });
  }
);

describe('counter approver privacy', () => {
  it.each(['RX', 'OPERATION'] as const)(
    'exposes only identity and display name for %s',
    async (purpose) => {
      const f = fixture('STAFFED');
      await expect(f.caller.rxApprovers({ branchId: 'branch', purpose })).resolves.toEqual({
        mode: 'STAFFED',
        users: [{ id: 'checker', name: 'Checker' }],
      });
      expect(f.db.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: { id: true, name: true },
          where: expect.objectContaining({ organizationId: 'org', status: 'ACTIVE' }),
        })
      );
    }
  );
});
