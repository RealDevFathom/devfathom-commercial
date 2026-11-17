import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  can: vi.fn(),
  licensed: vi.fn(),
  audit: vi.fn(),
  move: vi.fn(),
  post: vi.fn(),
  pin: vi.fn(),
  mayRefund: vi.fn(),
  access: vi.fn(),
  drawer: vi.fn(),
  cash: vi.fn(),
  save: vi.fn(),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', async () => ({
  ...(await vi.importActual<typeof import('@/lib/abac')>('@/lib/abac')),
  can: mocks.can,
}));
vi.mock('@/lib/entitlements', () => ({
  hasModule: mocks.licensed,
  resolveOrganizationEntitlements: vi.fn(),
}));
vi.mock('@/server/audit', () => ({
  ipFromHeaders: vi.fn(),
  isAuditExcludedPath: () => true,
  recordTrpcAudit: vi.fn(),
  annotateAudit: mocks.audit,
}));
vi.mock('@/server/routers/pharmacy-sales', () => ({ requireDrawerManagerAccess: mocks.access }));
vi.mock('@/lib/pharmacy/refund-authorization', () => ({
  authenticateRefundPin: mocks.pin,
  actorMayRefund: mocks.mayRefund,
  REFUND_PIN_POLICY: 'PHARMACY_REFUND_MANAGER_PIN',
}));
vi.mock('@/lib/pharmacy/settlement', () => ({
  lockOpenPharmacyDrawer: mocks.drawer,
  assertDrawerOperator: vi.fn(),
  requireCurrentPharmacyBusinessDate: vi.fn(),
}));
vi.mock('@/lib/pharmacy/prepaid-tiers', async () => ({
  ...(await vi.importActual<typeof import('@/lib/pharmacy/prepaid-tiers')>(
    '@/lib/pharmacy/prepaid-tiers'
  )),
  movePrepaid: mocks.move,
  postPrepaidCash: mocks.post,
  publishPrepaidSettings: mocks.save,
}));
import { pharmacyPrepaidRouter } from './prepaid-router';
import type { TRPCContext } from '@/server/trpc';
const scope = { organizationId: 'org-a', branchId: 'branch-a', actorId: 'owner-a' };
function caller(role = 'ADMIN', organizationId = 'org-a') {
  const db = {
    $transaction: (run: (db: unknown) => unknown) => run(db),
    pharmacyDrawerMovement: { create: mocks.cash },
  };
  return pharmacyPrepaidRouter.createCaller({
    db,
    session: { expires: 'later', user: { id: 'owner-a', organizationId, role, status: 'ACTIVE' } },
    entitlements: { organizationId: 'org-a' },
    organization: { id: 'org-a' },
    support: null,
    requestMeta: { ip: null, userAgent: null },
    audit: { detail: {} },
  } as unknown as TRPCContext);
}
const input = {
  branchId: 'branch-a',
  customerId: 'customer-a',
  deviceId: 'counter-a',
  amountMinor: 10000,
  idempotencyKey: 'payment-123',
  kind: 'PAYMENT' as const,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.licensed.mockReturnValue(true);
  mocks.access.mockResolvedValue(scope);
  mocks.mayRefund.mockResolvedValue(true);
  mocks.pin.mockResolvedValue({ verified: true });
  mocks.drawer.mockResolvedValue({ id: 'drawer-a', businessDate: new Date() });
  mocks.move.mockResolvedValue({
    id: 'entry-a',
    kind: 'PAYMENT',
    amountMinor: 10000,
    createdAt: new Date(),
    replayed: false,
  });
  mocks.save.mockResolvedValue({ id: 'version-a', version: 1 });
});
describe('prepaid owner controls', () => {
  it('rejects denied and foreign tenant settings before any write', async () => {
    mocks.can.mockResolvedValue(false);
    await expect(caller('EMPLOYEE').save({ tiers: [], refundable: false })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    mocks.can.mockResolvedValue(true);
    await expect(
      caller('ADMIN', 'org-b').save({ tiers: [], refundable: false })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('records cash and its liability once, including on an idempotent retry', async () => {
    await caller().move(input);
    expect(mocks.cash).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
    mocks.move.mockResolvedValue({ id: 'entry-a', replayed: true });
    await caller().move(input);
    expect(mocks.cash).toHaveBeenCalledOnce();
    expect(mocks.post).toHaveBeenCalledOnce();
  });
  it('refuses refunds before money work when the actor or fresh PIN is denied', async () => {
    mocks.mayRefund.mockResolvedValue(false);
    await expect(caller().move({ ...input, kind: 'REFUND', pin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.pin).not.toHaveBeenCalled();
    mocks.mayRefund.mockResolvedValue(true);
    mocks.pin.mockResolvedValue({ blocked: 'PIN refused' });
    await expect(caller().move({ ...input, kind: 'REFUND', pin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.cash).not.toHaveBeenCalled();
  });
  it('accepts the solo owner’s own fresh PIN and audits verification without storing the PIN', async () => {
    await caller().move({ ...input, kind: 'REFUND', pin: '1234' });
    expect(mocks.pin).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'owner-a', pin: '1234' })
    );
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          pinVerified: true,
          policy: 'PHARMACY_REFUND_MANAGER_PIN',
        }),
      })
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('1234');
  });
});
