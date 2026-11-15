import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const tx = vi.hoisted(() => ({
  $queryRaw: vi.fn(),
  restaurantOperatorCredential: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  restaurantStaffProfile: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
}));
vi.mock('@/lib/tenancy/scoped-db', () => ({
  withTenantDb: vi.fn(async (_organizationId: string, run: (db: unknown) => unknown) => run(tx)),
}));

import { withTenantDb } from '@/lib/tenancy/scoped-db';
import {
  hashOperatorCredential,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  hasRefundApprovalPin,
  provisionRefundApprovalPin,
  RefundPinProvisionError,
  verifyRefundApproverPin,
} from './refund-approval';

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

describe('provisionRefundApprovalPin (DEV-645)', () => {
  const db = tx as unknown as ScopedDb;
  const input = { organizationId: 'org-a', userId: 'actor-a', displayName: 'Owner', pin: '7351' };

  beforeEach(() => {
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
    tx.restaurantStaffProfile.findFirst.mockResolvedValue(null);
    tx.restaurantStaffProfile.create.mockResolvedValue({ id: 'staff-new', status: 'ACTIVE' });
    tx.restaurantStaffProfile.findUnique.mockResolvedValue({ id: 'staff-new', status: 'ACTIVE' });
    tx.restaurantOperatorCredential.create.mockImplementation(async ({ data }) => ({
      id: 'cred-new',
      ...data,
    }));
  });

  it('creates a staff profile and a hashed organization-wide PIN for a first-time owner', async () => {
    await expect(provisionRefundApprovalPin(db, input)).resolves.toEqual({
      id: 'cred-new',
      staffProfileId: 'staff-new',
    });
    expect(tx.restaurantStaffProfile.create).toHaveBeenCalledWith({
      data: { organizationId: 'org-a', userId: 'actor-a', displayName: 'Owner' },
    });
    const data = tx.restaurantOperatorCredential.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ staffProfileId: 'staff-new', type: 'PIN', deviceId: null });
    expect(data.credentialHash).not.toContain('7351');
    expect(await verifyOperatorCredential('PIN', '7351', data.credentialHash)).toBe(true);
  });

  it('never replaces an existing PIN', async () => {
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue({ id: 'cred-a' });
    await expect(provisionRefundApprovalPin(db, input)).rejects.toBeInstanceOf(
      RefundPinProvisionError
    );
    expect(tx.restaurantOperatorCredential.create).not.toHaveBeenCalled();
  });

  it('refuses a suspended staff profile', async () => {
    tx.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'staff-a', status: 'SUSPENDED' });
    await expect(provisionRefundApprovalPin(db, input)).rejects.toMatchObject({
      reason: 'PROFILE_INACTIVE',
    });
    expect(tx.restaurantOperatorCredential.create).not.toHaveBeenCalled();
  });

  it('reports whether the actor already has an active PIN', async () => {
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue({ id: 'cred-a' });
    await expect(hasRefundApprovalPin(db, 'org-a', 'actor-a')).resolves.toBe(true);
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
    await expect(hasRefundApprovalPin(db, 'org-a', 'actor-a')).resolves.toBe(false);
  });
});
