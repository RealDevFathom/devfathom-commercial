import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  restaurantOperatorCredential: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => unknown) => run(tx)),
}));

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { hashOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { verifyRefundApproverPin } from './refund-approval';

const now = new Date('2026-11-14T08:30:00Z');
let credentialHash = '';

beforeEach(async () => {
  vi.clearAllMocks();
  credentialHash ||= await hashOperatorCredential('PIN', '4821');
  tx.$queryRaw.mockResolvedValue([]);
  tx.restaurantOperatorCredential.update.mockResolvedValue({});
  tx.restaurantOperatorCredential.findFirst.mockResolvedValue({
    id: 'cred-a',
    staffProfileId: 'staff-a',
    credentialHash,
    failedAttempts: 0,
    lockedUntil: null,
  });
});

describe('verifyRefundApproverPin (DEV-645)', () => {
  it("accepts the actor's own PIN in an independent tenant transaction", async () => {
    await expect(verifyRefundApproverPin('org-a', 'actor-a', '4821', now)).resolves.toEqual({
      staffProfileId: 'staff-a',
      pinReauthenticatedAt: now,
    });
    expect(withTenantDb).toHaveBeenCalledWith('org-a', expect.any(Function), {
      skipDrain: true,
      userId: 'actor-a',
    });
    // Only the signed-in actor's own active credential is considered.
    expect(tx.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          staffProfile: expect.objectContaining({ userId: 'actor-a', status: 'ACTIVE' }),
        }),
      })
    );
    expect(tx.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred-a' },
      data: expect.objectContaining({ failedAttempts: 0 }),
    });
  });

  it('records a strike for a wrong PIN and refuses', async () => {
    await expect(verifyRefundApproverPin('org-a', 'actor-a', '1111', now)).resolves.toBeNull();
    expect(tx.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred-a' },
      data: expect.objectContaining({ failedAttempts: 1 }),
    });
  });

  it('refuses a locked-out credential even with the right PIN', async () => {
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue({
      id: 'cred-a',
      staffProfileId: 'staff-a',
      credentialHash,
      failedAttempts: 5,
      lockedUntil: new Date(now.getTime() + 60_000),
    });
    await expect(verifyRefundApproverPin('org-a', 'actor-a', '4821', now)).resolves.toBeNull();
    expect(tx.restaurantOperatorCredential.update).not.toHaveBeenCalled();
  });

  it('refuses an actor with no active staff PIN', async () => {
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
    await expect(verifyRefundApproverPin('org-a', 'actor-a', '4821', now)).resolves.toBeNull();
  });

  it('refuses a malformed PIN without reading credentials', async () => {
    await expect(verifyRefundApproverPin('org-a', 'actor-a', '12', now)).resolves.toBeNull();
    expect(tx.restaurantOperatorCredential.findFirst).not.toHaveBeenCalled();
  });
});
