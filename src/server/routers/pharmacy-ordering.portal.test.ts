import { beforeEach, describe, expect, it, vi } from 'vitest';

// DEV-15 (#762): staff decisions on customer PWA requests. The permission is
// checked on the server: a prescription-photo order or refill needs the
// pharmacist dispensing permission; a Raast khata payment needs counter access.
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
  annotateAudit: vi.fn(),
}));
vi.mock('@/lib/pharmacy/customer-portal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/pharmacy/customer-portal')>()),
  decidePortalRequest: vi.fn(async () => ({ id: 'r-1', kind: 'RX_ORDER' })),
  confirmPortalKhataPayment: vi.fn(async () => ({ receiptReference: 'KP-1' })),
}));

import { confirmPortalKhataPayment, decidePortalRequest } from '@/lib/pharmacy/customer-portal';
import { router, type TRPCContext } from '../trpc';
import { pharmacyOrderingRouter } from './pharmacy-ordering';

const app = router({ pharmacyOrdering: pharmacyOrderingRouter });
const BRANCH = 'branch-1';

let db: {
  user: { findUnique: ReturnType<typeof vi.fn> };
  pharmacyBranch: { findMany: ReturnType<typeof vi.fn> };
  pharmacyBranchAssignment: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $queryRaw: ReturnType<typeof vi.fn>;
};

function grant(...capabilities: string[]) {
  db.user.findUnique.mockResolvedValue({
    organizationRole: null,
    permissionOverrides: capabilities.map((capability) => ({ capability, effect: 'ALLOW' })),
  });
}

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
  vi.mocked(decidePortalRequest).mockClear();
  vi.mocked(confirmPortalKhataPayment).mockClear();
  db = {
    user: { findUnique: vi.fn() },
    pharmacyBranch: { findMany: vi.fn().mockResolvedValue([{ id: BRANCH }]) },
    // DEV-845: this staff member is assigned to the branch.
    pharmacyBranchAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'assignment-1' }) },
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
});

const verify = { branchId: BRANCH, requestId: 'r-1', decision: 'VERIFY' as const };

describe('pharmacyOrdering.portalDecide', () => {
  it('refuses a member with neither pharmacist nor counter permission', async () => {
    grant('pharmacy:orders');
    await expect(caller().portalDecide(verify)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(decidePortalRequest).not.toHaveBeenCalled();
  });

  it('lets counter staff decide only khata payment notices', async () => {
    grant('pharmacy:counter');
    await caller().portalDecide(verify);
    expect(decidePortalRequest).toHaveBeenCalledWith(
      db,
      { organizationId: 'org-1', branchId: BRANCH, actorId: 'actor-1' },
      verify,
      ['KHATA_PAYMENT']
    );
  });

  it('lets a pharmacist verify refills and prescription-photo orders', async () => {
    grant('pharmacy:dispense');
    await caller().portalDecide(verify);
    expect(vi.mocked(decidePortalRequest).mock.calls[0][3]).toEqual(['REFILL', 'RX_ORDER']);
  });
});

describe('pharmacyOrdering.portalConfirmPayment', () => {
  const input = { branchId: BRANCH, requestId: 'r-1', businessDate: new Date('2026-11-15') };

  it('needs counter access to post a payment', async () => {
    grant('pharmacy:dispense');
    await expect(caller().portalConfirmPayment(input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(confirmPortalKhataPayment).not.toHaveBeenCalled();
  });

  it('posts the payment for counter staff', async () => {
    grant('pharmacy:counter');
    await expect(caller().portalConfirmPayment(input)).resolves.toEqual({
      receiptReference: 'KP-1',
    });
  });
});
