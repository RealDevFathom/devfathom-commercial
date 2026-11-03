import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/restaurant/operator-credentials', async (original) => ({
  ...(await original<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: vi.fn(async () => false),
}));
import { verifyOperatorCredential } from '@/lib/restaurant/operator-credentials';
import { verifyInventoryWitness } from './inventory-witness';
const scope = { organizationId: 'org', branchId: 'branch', actorId: 'actor' };
function fixture() {
  const credential = {
    id: 'credential',
    credentialHash: 'synthetic-hash',
    failedAttempts: 0,
    lockedUntil: null as Date | null,
    staffProfile: {
      organizationId: 'org',
      status: 'ACTIVE',
      user: {
        id: 'witness',
        organizationId: 'org',
        status: 'ACTIVE',
        pharmacyBranchAssignments: [{ organizationId: 'org', branchId: 'branch', active: true }],
      },
    },
  };
  const update = vi.fn(
    async ({ data }: { data: { failedAttempts?: number; lockedUntil?: Date | null } }) =>
      Object.assign(credential, data)
  );
  const raw = {
    $queryRaw: vi.fn(),
    restaurantOperatorCredential: {
      findFirst: vi.fn(async () => credential),
      update,
    },
  };
  return { credential, update, raw, db: raw as unknown as ScopedDb };
}
const input = { staffProfileId: 'staff', pin: '1234' };
describe('inventory write-off witness authentication', () => {
  beforeEach(() => vi.mocked(verifyOperatorCredential).mockReset().mockResolvedValue(false));
  it('commits a failed attempt and locks out further guesses after five failures', async () => {
    const { db, credential, update } = fixture();
    for (let i = 0; i < 5; i++)
      await expect(verifyInventoryWitness(db, scope, input)).resolves.toHaveProperty('blocked');
    expect(update).toHaveBeenCalledTimes(5);
    expect(credential.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
    await expect(verifyInventoryWitness(db, scope, input)).resolves.toHaveProperty('blocked');
    expect(verifyOperatorCredential).toHaveBeenCalledTimes(5);
    expect(update).toHaveBeenCalledTimes(5);
  });
  it('returns the authenticated identity and clears old failures after success', async () => {
    const { db, credential, update } = fixture();
    credential.failedAttempts = 3;
    credential.lockedUntil = new Date(Date.now() - 1);
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
    await expect(verifyInventoryWitness(db, scope, input)).resolves.toEqual({
      witnessId: 'witness',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'credential' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  });
  it.each([
    'self',
    'foreign user',
    'foreign profile',
    'inactive user',
    'inactive profile',
    'unassigned',
    'inactive assignment',
    'foreign assignment',
  ])('refuses %s before comparing a PIN', async (reason) => {
    const { db, credential, update } = fixture(),
      user = credential.staffProfile.user;
    if (reason === 'self') user.id = scope.actorId;
    if (reason === 'foreign user') user.organizationId = 'foreign';
    if (reason === 'foreign profile') credential.staffProfile.organizationId = 'foreign';
    if (reason === 'inactive user') user.status = 'INACTIVE';
    if (reason === 'inactive profile') credential.staffProfile.status = 'INACTIVE';
    if (reason === 'unassigned') user.pharmacyBranchAssignments = [];
    if (reason === 'inactive assignment') user.pharmacyBranchAssignments[0]!.active = false;
    if (reason === 'foreign assignment')
      user.pharmacyBranchAssignments[0]!.organizationId = 'foreign';
    vi.mocked(verifyOperatorCredential).mockResolvedValue(true);
    await expect(verifyInventoryWitness(db, scope, input)).resolves.toHaveProperty('blocked');
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('refuses a missing/revoked credential without an identity or mutation', async () => {
    const { db, update } = fixture();
    vi.mocked(db.restaurantOperatorCredential.findFirst).mockResolvedValue(null);
    await expect(verifyInventoryWitness(db, scope, input)).resolves.toHaveProperty('blocked');
    expect(verifyOperatorCredential).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
