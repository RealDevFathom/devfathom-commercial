import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));

import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { hasRefundPin, provisionRefundPin, RefundPinSetupError } from './refund-authorization';

const tx = {
  $queryRaw: vi.fn(),
  restaurantOperatorCredential: { findFirst: vi.fn(), create: vi.fn() },
  restaurantStaffProfile: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
};
const db = tx as unknown as ScopedDb;
const input = { organizationId: 'org-a', userId: 'user-a', displayName: 'Owner', pin: '7351' };

beforeEach(() => {
  vi.clearAllMocks();
  tx.$queryRaw.mockResolvedValue([]);
  tx.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
  tx.restaurantStaffProfile.findFirst.mockResolvedValue(null);
  tx.restaurantStaffProfile.create.mockResolvedValue({ id: 'staff-new', status: 'ACTIVE' });
  tx.restaurantStaffProfile.findUnique.mockResolvedValue({ id: 'staff-new', status: 'ACTIVE' });
  tx.restaurantOperatorCredential.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: 'cred-new', ...data })
  );
});

describe('provisionRefundPin (DEV-645)', () => {
  it('creates a staff profile and a hashed organization-wide PIN for a first-time owner', async () => {
    await expect(provisionRefundPin(db, input)).resolves.toEqual({
      id: 'cred-new',
      staffProfileId: 'staff-new',
    });
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.restaurantStaffProfile.create).toHaveBeenCalledWith({
      data: { organizationId: 'org-a', userId: 'user-a', displayName: 'Owner' },
    });
    const data = tx.restaurantOperatorCredential.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ staffProfileId: 'staff-new', type: 'PIN', deviceId: null });
    expect(data.credentialHash).not.toContain('7351');
    expect(await verifyOperatorCredential('PIN', '7351', data.credentialHash)).toBe(true);
  });

  it('reuses an existing active staff profile', async () => {
    tx.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'staff-a', status: 'ACTIVE' });
    tx.restaurantStaffProfile.findUnique.mockResolvedValue({ id: 'staff-a', status: 'ACTIVE' });
    await expect(provisionRefundPin(db, input)).resolves.toMatchObject({
      staffProfileId: 'staff-a',
    });
    expect(tx.restaurantStaffProfile.create).not.toHaveBeenCalled();
  });

  it('never replaces an existing PIN', async () => {
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue({ id: 'cred-a' });
    await expect(provisionRefundPin(db, input)).rejects.toBeInstanceOf(RefundPinSetupError);
    expect(tx.restaurantOperatorCredential.create).not.toHaveBeenCalled();
  });

  it('refuses a suspended staff profile', async () => {
    tx.restaurantStaffProfile.findFirst.mockResolvedValue({ id: 'staff-a', status: 'SUSPENDED' });
    await expect(provisionRefundPin(db, input)).rejects.toMatchObject({
      reason: 'PROFILE_INACTIVE',
    });
    expect(tx.restaurantOperatorCredential.create).not.toHaveBeenCalled();
  });
});

describe('hasRefundPin (DEV-645)', () => {
  it("reports whether the actor's own active PIN exists", async () => {
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue({ id: 'cred-a' });
    await expect(hasRefundPin(db, 'org-a', 'user-a')).resolves.toBe(true);
    expect(tx.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-a',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
        staffProfile: { organizationId: 'org-a', userId: 'user-a', status: 'ACTIVE' },
      },
      select: { id: true },
    });
    tx.restaurantOperatorCredential.findFirst.mockResolvedValue(null);
    await expect(hasRefundPin(db, 'org-a', 'user-a')).resolves.toBe(false);
  });
});
