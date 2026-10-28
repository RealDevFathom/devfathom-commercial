import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { hash, compare } from 'bcryptjs';

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: vi.fn(async () => ({ ok: true })),
  clearRateLimit: vi.fn(async () => {}),
}));
const mocks = vi.hoisted(() => ({ withTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
import { authorizeSoloApproval, SOLO_APPROVAL_POLICY } from './solo-approval';

const scope = { organizationId: 'org', branchId: 'branch', actorId: 'owner' };
const target = { type: 'PharmacyPurchaseOrder', id: 'po' };
let db: ScopedDb;
let credential: {
  id: string;
  credentialHash: string;
  failedAttempts: number;
  lockedUntil: Date | null;
  revokedAt: Date | null;
};

beforeEach(async () => {
  credential = {
    id: 'cred',
    credentialHash: await hash('1234', 4),
    failedAttempts: 0,
    lockedUntil: null,
    revokedAt: null,
  };
  db = {
    $queryRaw: vi.fn().mockResolvedValue([{ allowed: true }]),
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => credential),
      findUnique: vi.fn(async () => credential),
      update: vi.fn(async ({ data }) => Object.assign(credential, data)),
    },
    auditLog: { create: vi.fn(async () => ({ id: 'audit' })) },
  } as unknown as ScopedDb;
  mocks.withTenantDb.mockReset().mockImplementation(async (_org, run) => run(db));
});

describe('solo owner PIN reauthentication', () => {
  it('requires singleton owner eligibility and a fresh PIN before touching credentials', async () => {
    vi.mocked(db.$queryRaw).mockResolvedValueOnce([{ allowed: false }]);
    expect(await authorizeSoloApproval(db, scope, target, '1234')).toBe(false);
    expect(await authorizeSoloApproval(db, scope, target)).toBe(false);
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('verifies the real bcrypt hash and atomically binds a secret-free audit to its document', async () => {
    expect(await compare('1234', credential.credentialHash)).toBe(true);
    expect(await authorizeSoloApproval(db, scope, target, '1234')).toBe(true);
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org', expect.any(Function), {
      userId: 'owner',
      skipDrain: true,
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorId: 'owner',
        targetId: 'po',
        targetType: 'PharmacyPurchaseOrder',
        action: SOLO_APPROVAL_POLICY,
        metadata: {
          branchId: 'branch',
          policy: SOLO_APPROVAL_POLICY,
          reauthentication: 'PIN',
          activeStaffCount: 1,
        },
      }),
    });
    expect(JSON.stringify(vi.mocked(db.auditLog.create).mock.calls)).not.toContain('1234');
    expect(db.$queryRaw).toHaveBeenLastCalledWith(expect.anything(), 'audit');
  });

  it('durably counts failed PINs and locks out the fifth attempt without an approval audit', async () => {
    for (let i = 0; i < 5; i++)
      expect(await authorizeSoloApproval(db, scope, target, '9999')).toBe(false);
    expect(credential.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await authorizeSoloApproval(db, scope, target, '1234')).toBe(false);
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledTimes(5);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('rechecks revocation after acquiring the credential lock', async () => {
    vi.mocked(db.restaurantOperatorCredential.findFirst).mockResolvedValueOnce(null);
    expect(await authorizeSoloApproval(db, scope, target, '1234')).toBe(false);
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});
