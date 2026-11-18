import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/entitlements', () => ({
  hasModule: vi.fn(() => true),
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', async (original) => ({
  ...(await original<typeof import('@/server/audit')>()),
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
  recordAudit: vi.fn(),
}));
// The key claim itself has its own suite (settlement.test.ts).
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  discardPharmacyTenderAttempt: vi.fn(),
}));
// The till's PIN approval has its own suite (counter-line-approval.test.ts).
vi.mock('@/lib/pharmacy/counter-line-approval', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/counter-line-approval')>()),
  authorizeCounterApproval: vi.fn(),
  confirmCounterApproval: vi.fn(),
  listCounterApprovers: vi.fn(),
}));

import { discardPharmacyTenderAttempt } from '@/lib/pharmacy/settlement';
import {
  authorizeCounterApproval,
  confirmCounterApproval,
  CounterApprovalDenied,
  listCounterApprovers,
} from '@/lib/pharmacy/counter-line-approval';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
const attempt = {
  branchId: 'branch-a',
  saleId: 'sale-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-11-03T00:00:00.000Z'),
  type: 'BANK_TRANSFER' as const,
  amountMinor: 1_250,
  idempotencyKey: 'counter-tender:sale-a:BANK_TRANSFER:1250',
};
const approval = {
  approvedByUserId: 'manager-a',
  approvalPolicy: 'MANAGER_PIN',
  selfApproved: false,
  credentialId: 'credential-a',
};
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'cashier-a' };

function fixture(capabilities: string[] = ['pharmacy:counter']) {
  const member = {
    status: 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: {
      permissions: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
    },
    permissionOverrides: [],
  };
  const db = {
    organization: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    user: { findUnique: vi.fn(async () => member) },
    pharmacyBranchAssignment: {
      findMany: vi.fn(async () => [{ branchId: 'branch-a' }]),
      findFirst: vi.fn(async () => ({ branchId: 'branch-a' })),
    },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id }))
      ),
    },
  };
  db.$transaction.mockImplementation(async (callback) => callback(db));
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'cashier-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  };
  return {
    db,
    context,
    caller: () => app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

const request = {
  attempt,
  reason: 'Customer did not pay',
  approval: { staffProfileId: 'staff-manager', pin: '4321' },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(authorizeCounterApproval).mockResolvedValue(approval);
  vi.mocked(discardPharmacyTenderAttempt).mockResolvedValue({ status: 'DISCARDED' });
});

describe('DEV-712 supervisor discard of an unknown payment attempt', () => {
  it('needs a manager or owner PIN, re-checks it in the transaction and records who and why', async () => {
    const f = fixture();
    await expect(f.caller().discardTenderAttempt(request)).resolves.toEqual({
      status: 'DISCARDED',
    });
    expect(authorizeCounterApproval).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining(scope),
      'TENDER_DISCARD',
      request.approval
    );
    expect(confirmCounterApproval).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining(scope),
      'TENDER_DISCARD',
      approval
    );
    expect(discardPharmacyTenderAttempt).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining(scope),
      attempt,
      {
        reason: 'Customer did not pay',
        approvedByUserId: 'manager-a',
        approvalPolicy: 'MANAGER_PIN',
        selfApproved: false,
      }
    );
    const call = vi.mocked(recordTrpcAudit).mock.calls.at(-1)?.[0] as {
      ctx: { audit: { detail: { metadata?: Record<string, unknown> } } };
      outcome: string;
    };
    expect(call.outcome).toBe('SUCCESS');
    expect(call.ctx.audit.detail.metadata).toMatchObject({
      tenderDiscard: {
        saleId: 'sale-a',
        approvedByUserId: 'manager-a',
        approvalPolicy: 'MANAGER_PIN',
        selfApproved: false,
        reason: 'Customer did not pay',
      },
      tenderDiscardOutcome: 'DISCARDED',
    });
    // The PIN is never copied into the audit detail.
    expect(JSON.stringify(call.ctx.audit.detail)).not.toContain('4321');
  });

  it('a solo owner self-approves with their own PIN, recorded as self-approved', async () => {
    vi.mocked(authorizeCounterApproval).mockResolvedValue({
      ...approval,
      approvedByUserId: 'cashier-a',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
    });
    const f = fixture();
    await f.caller().discardTenderAttempt(request);
    expect(vi.mocked(discardPharmacyTenderAttempt).mock.calls[0]?.[3]).toEqual({
      reason: 'Customer did not pay',
      approvedByUserId: 'cashier-a',
      approvalPolicy: 'SOLE_APPROVER_PIN_REAUTH',
      selfApproved: true,
    });
  });

  it('a refused PIN discards nothing', async () => {
    vi.mocked(authorizeCounterApproval).mockRejectedValue(
      new CounterApprovalDenied('TENDER_DISCARD')
    );
    const f = fixture();
    await expect(f.caller().discardTenderAttempt(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(discardPharmacyTenderAttempt).not.toHaveBeenCalled();
  });

  it('someone without counter access cannot discard', async () => {
    const f = fixture([]);
    await expect(f.caller().discardTenderAttempt(request)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(authorizeCounterApproval).not.toHaveBeenCalled();
    expect(discardPharmacyTenderAttempt).not.toHaveBeenCalled();
  });

  it('requires a reason', async () => {
    const f = fixture();
    await expect(
      f.caller().discardTenderAttempt({ ...request, reason: '  ' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(authorizeCounterApproval).not.toHaveBeenCalled();
  });

  it('returns an attempt that committed as accepted', async () => {
    const result = { tenderId: 'tender-a', settled: true, receiptNumber: 41, remainingMinor: 0 };
    vi.mocked(discardPharmacyTenderAttempt).mockResolvedValue({ status: 'ACCEPTED', result });
    const f = fixture();
    await expect(f.caller().discardTenderAttempt(request)).resolves.toEqual({
      status: 'ACCEPTED',
      result,
    });
  });

  it('a sale outside the branch is not found', async () => {
    vi.mocked(discardPharmacyTenderAttempt).mockResolvedValue(null);
    const f = fixture();
    await expect(f.caller().discardTenderAttempt(request)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('lists discard approvers under the TENDER_DISCARD capability', async () => {
    vi.mocked(listCounterApprovers).mockResolvedValue([
      { id: 'staff-manager', name: 'Manager', self: false },
    ]);
    const f = fixture();
    await expect(f.caller().tenderDiscardApprovers({ branchId: 'branch-a' })).resolves.toEqual([
      { id: 'staff-manager', name: 'Manager', self: false },
    ]);
    expect(listCounterApprovers).toHaveBeenCalledWith(
      f.db,
      expect.objectContaining(scope),
      'TENDER_DISCARD'
    );
  });
});
