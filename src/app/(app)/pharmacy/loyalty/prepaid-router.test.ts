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
  pinSet: vi.fn(),
  setPin: vi.fn(),
  liveOwner: vi.fn(),
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
vi.mock('@/lib/pharmacy/procurement-access', () => ({ actorIsPharmacyOwner: mocks.liveOwner }));
vi.mock('@/lib/pharmacy/refund-authorization', async () => ({
  authenticateRefundPin: mocks.pin,
  actorMayRefund: mocks.mayRefund,
  REFUND_PIN_POLICY: 'PHARMACY_REFUND_MANAGER_PIN',
  refundApprovalAudit: (
    await vi.importActual<typeof import('@/lib/pharmacy/refund-authorization')>(
      '@/lib/pharmacy/refund-authorization'
    )
  ).refundApprovalAudit,
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
  prepaidPinIsSet: mocks.pinSet,
  setPrepaidPin: mocks.setPin,
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
  mocks.pinSet.mockResolvedValue(true);
  mocks.liveOwner.mockResolvedValue(true);
  mocks.setPin.mockResolvedValue({ accountId: 'account-a' });
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
          // DEV-32: the owner who started the refund approved it with their own PIN.
          approverId: 'owner-a',
          initiatedById: 'owner-a',
          selfApproved: true,
          approvedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      })
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('1234');
  });
  it('refuses a delegated employee holding every grant, even with their own valid PIN', async () => {
    // The capability checks all pass and the employee's PIN verifies: only owner identity is missing.
    mocks.can.mockResolvedValue(true);
    mocks.pin.mockResolvedValue({ verified: true });
    const employee = caller('EMPLOYEE');
    await expect(employee.save({ tiers: [], refundable: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(employee.move({ ...input, kind: 'REFUND', pin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(employee.move(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      employee.setPin({ customerId: 'customer-a', customerPin: '4821' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(employee.overview({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.pin).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.cash).not.toHaveBeenCalled();
    expect(mocks.setPin).not.toHaveBeenCalled();
  });
  it('refuses a refund run under another member’s drawer scope', async () => {
    mocks.access.mockResolvedValue({ ...scope, actorId: 'manager-b' });
    await expect(caller().move({ ...input, kind: 'REFUND', pin: '1234' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(mocks.move).not.toHaveBeenCalled();
  });
  it('takes the first upfront payment only with the customer’s own new prepaid PIN', async () => {
    mocks.pinSet.mockResolvedValue(false);
    await expect(caller().move(input)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.cash).not.toHaveBeenCalled();
    await caller().move({ ...input, customerPin: '4821' });
    expect(mocks.move).toHaveBeenCalledOnce();
    expect(mocks.setPin).toHaveBeenCalledWith(expect.anything(), scope, {
      customerId: 'customer-a',
      pin: '4821',
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('4821');
  });
  it('lets the owner reset a forgotten customer PIN', async () => {
    await caller().setPin({ customerId: 'customer-a', customerPin: '7310' });
    expect(mocks.setPin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: 'org-a', actorId: 'owner-a' }),
      {
        customerId: 'customer-a',
        pin: '7310',
      }
    );
  });
  it('refuses a session ADMIN who is not the live owner, such as the owner-operator bundle', async () => {
    mocks.liveOwner.mockResolvedValue(false);
    const operator = caller('ADMIN');
    for (const attempt of [
      () => operator.overview({}),
      () => operator.save({ tiers: [], refundable: true }),
      () => operator.move(input),
      () => operator.move({ ...input, kind: 'REFUND', pin: '1234' }),
      () => operator.setPin({ customerId: 'customer-a', customerPin: '4821' }),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.liveOwner).toHaveBeenCalledWith(expect.anything(), 'org-a', 'owner-a');
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.pin).not.toHaveBeenCalled();
    expect(mocks.move).not.toHaveBeenCalled();
    expect(mocks.cash).not.toHaveBeenCalled();
    expect(mocks.setPin).not.toHaveBeenCalled();
  });
});
