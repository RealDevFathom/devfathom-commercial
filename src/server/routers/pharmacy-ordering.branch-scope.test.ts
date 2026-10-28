import { beforeEach, describe, expect, it, vi } from 'vitest';

// A delivery command can move cash through a counter drawer (a remittance, a
// failed delivery's cash refund), so, like the counter's own cash calls, it
// must refuse a branch that is not an active pharmacy branch of the caller's
// organization (`scopeFor`, one `assertInOrganization` lookup) before the
// delivery library reads or writes anything.
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
vi.mock('@/lib/pharmacy/customer-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/customer-delivery')>()),
  recordDeliveryCommand: vi.fn(),
}));

import { recordDeliveryCommand } from '@/lib/pharmacy/customer-delivery';
import { router, type TRPCContext } from '../trpc';
import { pharmacyOrderingRouter } from './pharmacy-ordering';

const app = router({ pharmacyOrdering: pharmacyOrderingRouter });
const BRANCH = 'branch-elsewhere';
const remittance = {
  branchId: BRANCH,
  orderId: 'order-1',
  action: 'REMIT' as const,
  amountMinor: 1500,
  reference: 'Rider handover',
  requestKey: 'remit-1',
  deviceId: 'counter-device',
  businessDate: new Date('2026-10-20T00:00:00.000Z'),
};
const recorded = { evidence: { id: 'evidence-1' }, totals: {}, replayed: false };

let db: {
  user: { findUnique: ReturnType<typeof vi.fn> };
  pharmacyBranch: { findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};

function caller() {
  return app.createCaller({
    db,
    entitlements: { organizationId: 'org-1', enabledModules: ['pharmacy-counter'], modules: [] },
    session: {
      expires: 'later',
      user: { id: 'actor-1', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: 'org-1' },
    },
    organization: { id: 'org-1', vertical: 'PHARMACY' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext).pharmacyOrdering;
}

beforeEach(() => {
  vi.mocked(recordDeliveryCommand)
    .mockReset()
    .mockResolvedValue(recorded as never);
  db = {
    // The capability check: this staff member holds `pharmacy:orders`.
    user: {
      findUnique: vi.fn().mockResolvedValue({
        role: 'EMPLOYEE',
        status: 'ACTIVE',
        organizationId: 'org-1',
        organizationRole: null,
        permissionOverrides: [{ capability: 'pharmacy:orders', effect: 'ALLOW' }],
      }),
    },
    // Unknown, inactive and another tenant's branch all read as "no such active branch".
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
});

describe('pharmacyOrdering.deliveryCommand: the branch in the input', () => {
  it('refuses a branch that is not an active branch of the organization, touching nothing', async () => {
    await expect(caller().deliveryCommand(remittance)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'That record is not in this workspace.',
    });
    expect(db.pharmacyBranch.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: [BRANCH] }, organizationId: 'org-1', active: true },
      select: { id: true },
    });
    expect(recordDeliveryCommand).not.toHaveBeenCalled();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('records the command on an active branch of the organization, scoped to it', async () => {
    db.pharmacyBranch.findMany.mockResolvedValue([{ id: BRANCH }]);
    await expect(caller().deliveryCommand(remittance)).resolves.toEqual(recorded);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(recordDeliveryCommand).toHaveBeenCalledExactlyOnceWith(
      db,
      { organizationId: 'org-1', branchId: BRANCH, actorId: 'actor-1' },
      remittance
    );
  });
});
