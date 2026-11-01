import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeSoloApproval } from './solo-approval';
const authorizeSoloOwnerApproval = (
  db: Parameters<typeof authorizeSoloApproval>[0],
  input: {
    organizationId: string;
    actorId: string;
    branchId: string;
    targetId: string;
    pin?: string;
    capability?: string;
    staffProfileId?: string;
  }
) =>
  authorizeSoloApproval(
    db,
    input,
    { type: 'PharmacyOpeningSession', id: input.targetId },
    input.pin
  );
import { verifyControlledPurchaseWitness } from './goods-receipt';
import { approveCount, approveTransfer } from './inventory-operations';

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: vi.fn(async () => ({ ok: true })),
  clearRateLimit: vi.fn(async () => {}),
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_org, fn) => fn(currentDb)),
}));
let currentDb: ReturnType<typeof fixture>;
const mocks = vi.hoisted(() => ({ can: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: mocks.can }));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  verifyOperatorCredential: mocks.verify,
  isLockedOut: () => false,
  clearLockout: () => ({ failedAttempts: 0, lockedUntil: null }),
  registerFailedAttempt: () => ({ failedAttempts: 1, lockedUntil: null }),
}));

const scope = { organizationId: 'org', actorId: 'owner', branchId: 'branch' };
function fixture(solo = true) {
  const actor = { id: 'owner', organizationId: 'org', status: 'ACTIVE', role: 'ADMIN' };
  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      strings.join('').includes('restaurant_staff_profiles')
        ? [{ userId: 'owner' }]
        : [{ allowed: solo }]
    ),
    organization: { findFirstOrThrow: vi.fn(async () => ({ pharmacyOperatingMode: 'SOLO' })) },
    user: { findFirst: vi.fn(async () => actor) },
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => ({
        id: 'credential',
        credentialHash: 'hash',
        staffProfile: { status: 'ACTIVE', user: actor },
      })),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
    pharmacyGoodsReceipt: {
      findFirst: vi.fn(async () => ({
        branchId: 'branch',
        qualifiedPersonUserId: 'owner',
        lines: [{ medicineId: 'med', acceptedCanonicalUnits: 1 }],
      })),
    },
    medicine: { findMany: vi.fn(async () => [{ id: 'med' }]) },
    pharmacyInventoryCount: {
      findFirst: vi.fn(async () => ({
        id: 'count',
        status: 'AWAITING_COAUTH',
        createdById: 'owner',
        lines: [],
      })),
      update: vi.fn(async ({ data }) => data),
    },
    pharmacyInterbranchTransfer: {
      findFirst: vi.fn(async () => ({
        id: 'transfer',
        status: 'ALLOCATED',
        allocatedById: 'owner',
      })),
      update: vi.fn(async ({ data }) => data),
    },
  };
  currentDb = db;
  return db;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.verify.mockResolvedValue(true);
});
describe('solo owner PIN authorization', () => {
  it('requires a fresh PIN and preserves lockout failures without a success audit', async () => {
    const db = fixture();
    const input = { ...scope, targetId: 'target', capability: 'pharmacy:dispense' as const };
    expect(await authorizeSoloOwnerApproval(db as never, input)).toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    mocks.verify.mockResolvedValue(false);
    expect(await authorizeSoloOwnerApproval(db as never, { ...input, pin: '1234' })).toBe(false);
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
  it('binds verified PIN evidence to actor, branch, target and current transaction without retaining the PIN', async () => {
    const db = fixture();
    expect(
      await authorizeSoloOwnerApproval(db as never, {
        ...scope,
        targetId: 'target',
        capability: 'pharmacy:dispense',
        pin: '1234',
        staffProfileId: 'profile',
      })
    ).toBe(true);
    expect(db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          staffProfile: expect.objectContaining({
            organizationId: 'org',
            userId: 'owner',
            status: 'ACTIVE',
          }),
        }),
      })
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'owner',
        targetId: 'target',
        metadata: expect.objectContaining({
          branchId: 'branch',
          reauthentication: 'PIN',
          policy: 'PHARMACY:SOLO_OWNER_PIN',
        }),
      }),
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain('1234');
  });
  it('refuses multi-staff self-witness before PIN verification and succeeds for a solo controlled purchase', async () => {
    const input = { goodsReceiptId: 'receipt', staffProfileId: 'profile', pin: '1234' };
    const multi = fixture(false);
    expect(await verifyControlledPurchaseWitness(multi as never, scope, input)).toHaveProperty(
      'blocked'
    );
    expect(mocks.verify).not.toHaveBeenCalled();
    const solo = fixture();
    expect(await verifyControlledPurchaseWitness(solo as never, scope, input)).toEqual({
      pharmacistId: 'owner',
      signatureRef: 'solo-purchase:receipt',
    });
    expect(solo.auditLog.create).toHaveBeenCalledOnce();
  });
  it.each(['count', 'transfer'] as const)(
    'keeps %s maker/checker and permits only PIN verified solo approval',
    async (kind) => {
      const multi = fixture(false);
      const approve = (db: ReturnType<typeof fixture>, pin?: string) =>
        kind === 'count'
          ? approveCount(db as never, scope, 'count', 'key', pin)
          : approveTransfer(db as never, scope, 'transfer', pin);
      await expect(approve(multi, '1234')).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
      expect(multi.auditLog.create).not.toHaveBeenCalled();
      const solo = fixture();
      await expect(approve(solo, '1234')).resolves.toMatchObject({
        status: 'APPROVED',
        approvedById: 'owner',
      });
      expect(solo.auditLog.create).toHaveBeenCalledOnce();
    }
  );
});
describe('inventory count variance threshold', () => {
  it('approves a below-threshold OPEN count without independent co-authorization', async () => {
    const db = fixture(false);
    db.pharmacyInventoryCount.findFirst.mockResolvedValueOnce({
      id: 'count',
      status: 'OPEN',
      createdById: 'owner',
      lines: [],
    });
    await expect(approveCount(db as never, scope, 'count', 'key')).resolves.toMatchObject({
      status: 'APPROVED',
      approvedById: 'owner',
    });
    expect(db.organization.findFirstOrThrow).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
