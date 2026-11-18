import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-647: a failed-delivery physical return that refunds cash needs a manager or owner who
// re-enters their own PIN. The delivery library calls the router's authorizer before refunding.
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
vi.mock('@/lib/pharmacy/customer-delivery', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/customer-delivery')>()),
  recordDeliveryCommand: vi.fn(),
}));
vi.mock('@/lib/pharmacy/refund-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/pharmacy/refund-authorization')>()),
  authenticateRefundPin: vi.fn(),
}));

import { FinancePostingError } from '@/lib/finance/journal';
import { recordDeliveryCommand } from '@/lib/pharmacy/customer-delivery';
import { authenticateRefundPin, REFUND_PIN_BLOCKED } from '@/lib/pharmacy/refund-authorization';
import { router, type TRPCContext } from '../trpc';
import { pharmacyOrderingRouter } from './pharmacy-ordering';

type Rule = { capability: string; effect: 'ALLOW' | 'DENY' };
const app = router({ pharmacyOrdering: pharmacyOrderingRouter });
const physicalReturn = {
  branchId: 'branch-a',
  orderId: 'order-a',
  action: 'PHYSICAL_RETURN' as const,
  reference: 'Goods back at branch',
  requestKey: 'return-a',
  deviceId: 'counter-device',
  businessDate: new Date('2026-11-14T00:00:00.000Z'),
};

function fixture(rules: Rule[]) {
  const db = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ organizationRole: { permissions: rules }, permissionOverrides: [] }),
    },
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([{ id: 'branch-a' }]) },
    // DEV-845: the staff member is assigned to the branch.
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment-a' }) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown): Promise<unknown> =>
      callback(db)
    ),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const audit = { detail: {} as { metadata?: Record<string, unknown> } };
  const caller = app.createCaller({
    db,
    entitlements: { organizationId: 'org-a', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'user-a', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-a' },
    },
    organization: { id: 'org-a', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit,
  } as unknown as TRPCContext).pharmacyOrdering;
  return { db, audit, caller };
}

const CASHIER: Rule[] = [
  { capability: 'pharmacy:counter', effect: 'ALLOW' },
  { capability: 'pharmacy:orders', effect: 'ALLOW' },
];
const MANAGER: Rule[] = [
  { capability: 'pharmacy:manage', effect: 'ALLOW' },
  { capability: 'pharmacy:orders', effect: 'ALLOW' },
];

beforeEach(() => {
  vi.clearAllMocks();
  // The delivery library runs the authorizer only when a refund is due; this one always is.
  vi.mocked(recordDeliveryCommand).mockImplementation(async (_db, _scope, _input, options) => {
    await options!.authorizeRefund!();
    return { refunded: true } as never;
  });
  vi.mocked(authenticateRefundPin).mockResolvedValue({ verified: true });
});

describe('DEV-647 delivery physical-return refunds', () => {
  it('refuses a cashier before any PIN check', async () => {
    const f = fixture(CASHIER);
    await expect(
      f.caller.deliveryCommand({ ...physicalReturn, managerPin: '7391' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Only a manager or owner can refund.' });
    expect(authenticateRefundPin).not.toHaveBeenCalled();
  });

  it('refuses a manager who gives no PIN', async () => {
    const f = fixture(MANAGER);
    await expect(f.caller.deliveryCommand(physicalReturn)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: REFUND_PIN_BLOCKED,
    });
    expect(authenticateRefundPin).not.toHaveBeenCalled();
    expect(f.audit.detail.metadata).toMatchObject({
      pinVerified: false,
      selfApproved: false,
      approvedAt: null,
    });
  });

  it('refuses a manager whose PIN is refused', async () => {
    vi.mocked(authenticateRefundPin).mockResolvedValueOnce({ blocked: REFUND_PIN_BLOCKED });
    const f = fixture(MANAGER);
    await expect(
      f.caller.deliveryCommand({ ...physicalReturn, managerPin: '8642' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: REFUND_PIN_BLOCKED });
  });

  it('refunds for a manager with their own verified PIN and audits it', async () => {
    const f = fixture(MANAGER);
    await expect(
      f.caller.deliveryCommand({ ...physicalReturn, managerPin: '7391' })
    ).resolves.toEqual({ refunded: true });
    expect(authenticateRefundPin).toHaveBeenCalledExactlyOnceWith({
      organizationId: 'org-a',
      actorId: 'user-a',
      pin: '7391',
      action: 'pharmacyOrdering.deliveryCommand',
    });
    expect(f.audit.detail.metadata).toMatchObject({
      policy: 'PHARMACY_REFUND_MANAGER_PIN',
      approverId: 'user-a',
      pinVerified: true,
      // DEV-32: the manager who started the refund approved it with their own PIN.
      initiatedById: 'user-a',
      selfApproved: true,
      approvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });
});

describe('DEV-877 delivery postings inside a closed accounting period', () => {
  it('returns a typed PERIOD_CLOSED refusal when the delivery refund cannot post', async () => {
    vi.mocked(recordDeliveryCommand).mockRejectedValueOnce(
      new FinancePostingError('PERIOD_CLOSED')
    );
    const f = fixture(MANAGER);
    await expect(
      f.caller.deliveryCommand({ ...physicalReturn, managerPin: '7391' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'PERIOD_CLOSED' });
  });
});
