import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const db = vi.hoisted(() => ({
  $queryRaw: vi.fn().mockResolvedValue([]),
  restaurantOperatorCredential: { findFirst: vi.fn(), update: vi.fn() },
  auditLog: { create: vi.fn() },
  // The approval check reads the owner's authenticator policy: fixed PINs are allowed
  // and this manager has enrolled no authenticator, so the PIN itself is verified.
  organization: { findFirst: vi.fn().mockResolvedValue({ requireApprovalAuthenticator: false }) },
  approvalAuthenticator: { findFirst: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_org: string, run: (tx: unknown) => unknown) => run(db)),
}));
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { authenticateDayReopenPin, DAY_REOPEN_PIN_BLOCKED } from './day-reopen-authorization';

const input = { organizationId: 'tenant-a', actorId: 'manager-a', pin: '4321' };
let credentialHash: string;
beforeAll(async () => {
  credentialHash = await hashOperatorCredential('PIN', input.pin);
});
beforeEach(() => {
  vi.clearAllMocks();
  db.restaurantOperatorCredential.findFirst.mockResolvedValue({
    id: 'credential-a',
    credentialHash,
    failedAttempts: 0,
    lockedUntil: null,
  });
});

describe('fresh day-reopen credentials', () => {
  it('authenticates only the current active actor in the current tenant on every attempt', async () => {
    await expect(authenticateDayReopenPin(input)).resolves.toEqual({ verified: true });
    await expect(authenticateDayReopenPin(input)).resolves.toEqual({ verified: true });
    expect(db.restaurantOperatorCredential.findFirst).toHaveBeenCalledTimes(2);
    expect(db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'tenant-a',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
        staffProfile: {
          organizationId: 'tenant-a',
          userId: 'manager-a',
          status: 'ACTIVE',
          user: { organizationId: 'tenant-a', status: 'ACTIVE' },
        },
      },
      orderBy: { id: 'asc' },
    });
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });

  it('persists a wrong-PIN strike and failure audit without storing the credential', async () => {
    await expect(authenticateDayReopenPin({ ...input, pin: '0000' })).resolves.toEqual({
      blocked: DAY_REOPEN_PIN_BLOCKED,
    });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential-a' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'tenant-a',
        actorId: 'manager-a',
        outcome: 'FAILURE',
        errorCode: 'DAY_REOPEN_PIN_REFUSED',
      }),
    });
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toMatch(/4321|0000|credentialHash/);
  });

  it.each(['missing', 'locked'])(
    'refuses a %s self credential even with the correct PIN',
    async (state) => {
      db.restaurantOperatorCredential.findFirst.mockResolvedValue(
        state === 'missing'
          ? null
          : {
              id: 'credential-a',
              credentialHash,
              failedAttempts: 5,
              lockedUntil: new Date(Date.now() + 60_000),
            }
      );
      await expect(authenticateDayReopenPin(input)).resolves.toEqual({
        blocked: DAY_REOPEN_PIN_BLOCKED,
      });
      expect(db.restaurantOperatorCredential.update).not.toHaveBeenCalled();
      expect(db.auditLog.create).toHaveBeenCalledOnce();
    }
  );
});
