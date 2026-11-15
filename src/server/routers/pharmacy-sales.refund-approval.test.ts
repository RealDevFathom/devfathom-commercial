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
  ipFromHeaders: vi.fn(() => null),
  isAuditExcludedPath: vi.fn(() => false),
  recordTrpcAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/refund-approval', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refund-approval')>()),
  verifyRefundApproverPin: vi.fn(),
  hasRefundApprovalPin: vi.fn(),
  provisionRefundApprovalPin: vi.fn(),
}));
vi.mock('@/lib/pharmacy/settlement', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/settlement')>()),
  refundPharmacyTender: vi.fn(),
}));

import { refundPharmacyTender } from '@/lib/pharmacy/settlement';
import {
  hasRefundApprovalPin,
  provisionRefundApprovalPin,
  RefundPinProvisionError,
  verifyRefundApproverPin,
} from '@/lib/pharmacy/refund-approval';
import { recordTrpcAudit } from '@/server/audit';
import { router, type TRPCContext } from '../trpc';
import { pharmacySalesRouter } from './pharmacy-sales';

const app = router({ pharmacySales: pharmacySalesRouter });
type Permission = { capability: string; effect: 'ALLOW' | 'DENY' };
const counter: Permission = { capability: 'pharmacy:counter', effect: 'ALLOW' };
const manage: Permission = { capability: 'pharmacy:manage', effect: 'ALLOW' };
const refund = {
  branchId: 'branch-a',
  originalTenderId: 'tender-a',
  deviceId: 'device-a',
  businessDate: new Date('2026-11-14'),
  amountMinor: 250,
  reason: 'Returned medicine',
  idempotencyKey: 'refund-a',
};

function fixture(
  permissions: Permission[],
  options: { role?: 'ADMIN' | 'EMPLOYEE'; tenderType?: string; overrides?: Permission[] } = {}
) {
  const member = {
    status: 'ACTIVE',
    organizationId: 'org-a',
    organizationRole: { permissions },
    permissionOverrides: options.overrides ?? [],
  };
  const db = {
    user: { findUnique: vi.fn(async () => member) },
    pharmacyBranch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-a' }),
      findMany: vi.fn(async ({ where }: { where?: { id?: { in: string[] } } }) =>
        where?.id ? where.id.in.map((id) => ({ id })) : [{ id: 'branch-a', name: 'Main' }]
      ),
    },
    pharmacyBranchAssignment: { findMany: vi.fn().mockResolvedValue([{ branchId: 'branch-a' }]) },
    pharmacyTender: {
      findFirst: vi.fn().mockResolvedValue({ type: options.tenderType ?? 'CASH' }),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ currency: 'PKR', timezone: null }) },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback(db));
  const context = {
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: {
        id: 'actor-a',
        name: 'Manager A',
        email: 'manager@example.invalid',
        role: options.role ?? 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-a',
      },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} as Record<string, unknown> },
  };
  return {
    db,
    context,
    caller: app.createCaller(context as unknown as TRPCContext).pharmacySales,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(hasRefundApprovalPin).mockResolvedValue(true);
  vi.mocked(provisionRefundApprovalPin).mockResolvedValue({
    id: 'cred-a',
    staffProfileId: 'staff-a',
  });
  vi.mocked(verifyRefundApproverPin).mockResolvedValue({
    staffProfileId: 'staff-a',
    pinReauthenticatedAt: new Date('2026-11-14T08:30:00Z'),
  });
  vi.mocked(refundPharmacyTender).mockResolvedValue({
    refundId: 'refund-1',
    originalTenderId: 'tender-a',
    amountMinor: 250,
    replayed: false,
  });
});

describe('DEV-645 refunds need a manager or owner PIN', () => {
  it('denies a cashier even with a PIN, before checking it or moving money', async () => {
    const f = fixture([counter]);
    await expect(f.caller.refundTender({ ...refund, approvalPin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a manager or owner can refund.',
    });
    expect(verifyRefundApproverPin).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('denies a cashier credit (Khata) refund too', async () => {
    const f = fixture([counter], { tenderType: 'CREDIT' });
    await expect(f.caller.refundTender({ ...refund, approvalPin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a manager or owner can refund.',
    });
    expect(verifyRefundApproverPin).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('lets a manage DENY override beat a wildcard owner grant', async () => {
    const f = fixture([{ capability: '*', effect: 'ALLOW' }], {
      overrides: [{ capability: 'pharmacy:manage', effect: 'DENY' }],
    });
    await expect(f.caller.refundTender({ ...refund, approvalPin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('denies a manager who sends no PIN', async () => {
    const f = fixture([counter, manage]);
    await expect(f.caller.refundTender(refund)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Enter your manager or owner PIN.',
    });
    expect(verifyRefundApproverPin).not.toHaveBeenCalled();
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('rejects a malformed PIN at the input boundary', async () => {
    const f = fixture([counter, manage]);
    await expect(f.caller.refundTender({ ...refund, approvalPin: '12' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it('denies a manager whose PIN the server does not accept', async () => {
    vi.mocked(verifyRefundApproverPin).mockResolvedValue(null);
    const f = fixture([counter, manage]);
    await expect(f.caller.refundTender({ ...refund, approvalPin: '0000' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Your PIN was not accepted. Refund not recorded.',
    });
    expect(verifyRefundApproverPin).toHaveBeenCalledExactlyOnceWith('org-a', 'actor-a', '0000');
    expect(refundPharmacyTender).not.toHaveBeenCalled();
  });

  it.each([
    ['Manager', [counter, manage]],
    ['Owner', [{ capability: 'pharmacy:*', effect: 'ALLOW' } as Permission]],
    ['bootstrap admin', [{ capability: '*', effect: 'ALLOW' } as Permission]],
  ])('allows a %s with their own PIN and audits the approval', async (_name, permissions) => {
    const f = fixture(permissions);
    await expect(f.caller.refundTender({ ...refund, approvalPin: '4821' })).resolves.toMatchObject({
      refundId: 'refund-1',
    });
    expect(verifyRefundApproverPin).toHaveBeenCalledExactlyOnceWith('org-a', 'actor-a', '4821');
    // The PIN never reaches the idempotent refund payload or its hash.
    expect(refundPharmacyTender).toHaveBeenCalledExactlyOnceWith(
      f.db,
      { organizationId: 'org-a', branchId: 'branch-a', actorId: 'actor-a' },
      refund
    );
    expect(f.context.audit.detail).toMatchObject({
      metadata: {
        refundApproval: {
          policy: 'PHARMACY_REFUND_MANAGER_PIN',
          approverId: 'actor-a',
          staffProfileId: 'staff-a',
          pinReauthenticatedAt: '2026-11-14T08:30:00.000Z',
        },
      },
    });
    const audited = vi.mocked(recordTrpcAudit).mock.calls.at(-1)?.[0];
    expect(JSON.stringify(audited?.ctx.audit)).toContain('refundApproval');
  });
});

describe('DEV-645 counter refund entry visibility', () => {
  it.each([
    ['cashier', [counter], false],
    ['pharmacist', [{ capability: 'pharmacy:dispense', effect: 'ALLOW' } as Permission], false],
    ['manager', [counter, manage], true],
    ['owner', [{ capability: 'pharmacy:*', effect: 'ALLOW' } as Permission], true],
  ])('reports refundsAuthorized for a %s', async (_name, permissions, expected) => {
    const f = fixture(permissions);
    await expect(f.caller.counterBranches()).resolves.toMatchObject({
      refundsAuthorized: expected,
    });
  });
});

describe('DEV-645 first-time refund PIN setup', () => {
  it('tells a manager or owner without a PIN to set one up', async () => {
    vi.mocked(hasRefundApprovalPin).mockResolvedValue(false);
    const f = fixture([counter, manage]);
    await expect(f.caller.counterBranches()).resolves.toMatchObject({
      refundsAuthorized: true,
      refundPinReady: false,
    });
    expect(hasRefundApprovalPin).toHaveBeenCalledWith(f.db, 'org-a', 'actor-a');
  });

  it('never looks up a PIN for staff who cannot refund', async () => {
    const f = fixture([counter]);
    await expect(f.caller.counterBranches()).resolves.toMatchObject({
      refundsAuthorized: false,
      refundPinReady: false,
    });
    expect(hasRefundApprovalPin).not.toHaveBeenCalled();
  });

  it('refuses PIN setup for a cashier', async () => {
    const f = fixture([counter]);
    await expect(f.caller.provisionMyRefundPin({ pin: '7351' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(provisionRefundApprovalPin).not.toHaveBeenCalled();
  });

  it("sets a manager's own first PIN without auditing it", async () => {
    const f = fixture([counter, manage]);
    await expect(f.caller.provisionMyRefundPin({ pin: '7351' })).resolves.toEqual({
      id: 'cred-a',
      staffProfileId: 'staff-a',
    });
    expect(provisionRefundApprovalPin).toHaveBeenCalledExactlyOnceWith(f.db, {
      organizationId: 'org-a',
      userId: 'actor-a',
      displayName: 'Manager A',
      pin: '7351',
    });
    expect(f.context.audit.detail).toMatchObject({ skipInput: true });
  });

  it('refuses to replace an existing PIN', async () => {
    vi.mocked(provisionRefundApprovalPin).mockRejectedValue(
      new RefundPinProvisionError('You already have a staff PIN.', 'ALREADY_EXISTS')
    );
    const f = fixture([counter, manage]);
    await expect(f.caller.provisionMyRefundPin({ pin: '7351' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
