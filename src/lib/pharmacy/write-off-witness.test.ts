import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  can: vi.fn(async () => true),
  soloOwnerApprovalAllowed: vi.fn(async () => false),
  isSolePharmacist: vi.fn(async () => false),
  verifyOperatorCredential: vi.fn(
    async (_type: string, secret: string, credentialHash: string) =>
      credentialHash === `hash:${secret}`
  ),
  withTenantDb: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/abac', () => ({ can: mocks.can }));
vi.mock('@/lib/tenancy/scoped-db', () => ({ withTenantDb: mocks.withTenantDb }));
vi.mock('./purchase-approval', () => ({
  SOLO_OWNER_POLICY: 'PHARMACY_SOLO_OWNER_PIN',
  soloOwnerApprovalAllowed: mocks.soloOwnerApprovalAllowed,
}));
vi.mock('./controlled-restoration-authorization', () => ({
  SOLO_PHARMACIST_WITNESS_POLICY: 'PHARMACY_SOLO_PHARMACIST_PIN',
  isSolePharmacist: mocks.isSolePharmacist,
}));
vi.mock('@/lib/restaurant/operator-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/restaurant/operator-credentials')>()),
  verifyOperatorCredential: mocks.verifyOperatorCredential,
}));

import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  authorizeWriteOffWitness,
  recordWriteOffWitnessEvidence,
  WRITE_OFF_WITNESS_PIN_POLICY,
  writeOffWitnessOptions,
} from './write-off-witness';

const scope = { organizationId: 'org_a', branchId: 'branch_a', actorId: 'user_actor' };
const assignedToBranch = {
  organizationId: 'org_a',
  status: 'ACTIVE',
  pharmacyBranchAssignments: {
    some: { organizationId: 'org_a', branchId: 'branch_a', active: true },
  },
};

function database() {
  return {
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    restaurantOperatorCredential: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'credential_1',
        credentialHash: 'hash:2468',
        failedAttempts: 0,
        lockedUntil: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit_1' }) },
    $queryRaw: vi.fn(async () => []),
  };
}

let db = database();
const scoped = () => db as unknown as ScopedDb;
const markerSet = () =>
  db.$queryRaw.mock.calls.some((call) =>
    String((call as unknown[])[0]).includes('app.pharmacy_write_off_solo_witness_user_id')
  );

beforeEach(() => {
  db = database();
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.soloOwnerApprovalAllowed.mockResolvedValue(false);
  mocks.isSolePharmacist.mockResolvedValue(false);
  mocks.withTenantDb.mockImplementation(async (_org: string, run: (tx: unknown) => unknown) =>
    run(db)
  );
});

describe('authorizeWriteOffWitness: a second person (DEV-628)', () => {
  it('accepts an assigned witness only after their own PIN verifies, in its own transaction', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'user_witness' });

    await expect(
      authorizeWriteOffWitness(scoped(), scope, { witnessId: 'user_witness', witnessPin: '2468' })
    ).resolves.toEqual({
      witnessId: 'user_witness',
      soloSelfWitness: false,
      policy: WRITE_OFF_WITNESS_PIN_POLICY,
    });
    expect(db.user.findFirst).toHaveBeenCalledWith({
      where: { ...assignedToBranch, id: 'user_witness' },
      select: { id: true },
    });
    expect(mocks.withTenantDb).toHaveBeenCalledWith('org_a', expect.any(Function), {
      userId: 'user_actor',
      skipDrain: true,
    });
    expect(db.restaurantOperatorCredential.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'org_a',
        type: 'PIN',
        revokedAt: null,
        deviceId: null,
        staffProfile: expect.objectContaining({ userId: 'user_witness', status: 'ACTIVE' }),
      }),
      orderBy: { id: 'asc' },
    });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential_1' },
      data: { failedAttempts: 0, lockedUntil: null },
    });
    expect(markerSet()).toBe(false);
  });

  it('refuses a wrong witness PIN and records the strike', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'user_witness' });

    await expect(
      authorizeWriteOffWitness(scoped(), scope, { witnessId: 'user_witness', witnessPin: '1111' })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(db.restaurantOperatorCredential.update).toHaveBeenCalledWith({
      where: { id: 'credential_1' },
      data: { failedAttempts: 1, lockedUntil: null },
    });
  });

  it('refuses a witness with no PIN set up', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'user_witness' });
    db.restaurantOperatorCredential.findFirst.mockResolvedValue(null);

    await expect(
      authorizeWriteOffWitness(scoped(), scope, { witnessId: 'user_witness', witnessPin: '2468' })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
  });

  it('refuses a locked-out witness PIN without checking it', async () => {
    db.user.findFirst.mockResolvedValue({ id: 'user_witness' });
    db.restaurantOperatorCredential.findFirst.mockResolvedValue({
      id: 'credential_1',
      credentialHash: 'hash:2468',
      failedAttempts: 0,
      lockedUntil: new Date(Date.now() + 60_000),
    });

    await expect(
      authorizeWriteOffWitness(scoped(), scope, { witnessId: 'user_witness', witnessPin: '2468' })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(mocks.verifyOperatorCredential).not.toHaveBeenCalled();
  });

  it('refuses a witness who is not assigned to the branch before asking for a PIN', async () => {
    db.user.findFirst.mockResolvedValue(null);

    await expect(
      authorizeWriteOffWitness(scoped(), scope, { witnessId: 'user_other', witnessPin: '2468' })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('refuses a malformed PIN before any lookup', async () => {
    await expect(
      authorizeWriteOffWitness(scoped(), scope, { witnessId: 'user_witness', witnessPin: 'abcd' })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});

describe('authorizeWriteOffWitness: solo-pharmacy rule', () => {
  const self = { witnessId: scope.actorId, witnessPin: '2468' };

  it('refuses a self-witness while anyone else is assigned to the branch', async () => {
    db.user.count.mockResolvedValue(1);
    mocks.soloOwnerApprovalAllowed.mockResolvedValue(true);

    await expect(authorizeWriteOffWitness(scoped(), scope, self)).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });
    expect(db.user.count).toHaveBeenCalledWith({
      where: { ...assignedToBranch, id: { not: scope.actorId } },
    });
    expect(mocks.withTenantDb).not.toHaveBeenCalled();
  });

  it('lets a solo owner witness with their own fresh PIN and marks the transaction', async () => {
    mocks.soloOwnerApprovalAllowed.mockResolvedValue(true);

    await expect(authorizeWriteOffWitness(scoped(), scope, self)).resolves.toEqual({
      witnessId: scope.actorId,
      soloSelfWitness: true,
      policy: 'PHARMACY_SOLO_OWNER_PIN',
    });
    expect(mocks.soloOwnerApprovalAllowed).toHaveBeenCalledWith(
      db,
      'org_a',
      'user_actor',
      'branch_a'
    );
    expect(markerSet()).toBe(true);
  });

  it('lets the sole pharmacist witness with their own fresh PIN', async () => {
    db.user.findFirst.mockResolvedValue({ id: scope.actorId });
    mocks.isSolePharmacist.mockResolvedValue(true);

    await expect(authorizeWriteOffWitness(scoped(), scope, self)).resolves.toMatchObject({
      soloSelfWitness: true,
      policy: 'PHARMACY_SOLO_PHARMACIST_PIN',
    });
    expect(mocks.can).toHaveBeenCalledWith(
      { id: scope.actorId },
      'pharmacy:dispense',
      undefined,
      expect.anything()
    );
  });

  it('refuses a lone member who is neither owner nor pharmacist', async () => {
    db.user.findFirst.mockResolvedValue({ id: scope.actorId });
    mocks.can.mockResolvedValue(false);
    mocks.isSolePharmacist.mockResolvedValue(true);

    await expect(authorizeWriteOffWitness(scoped(), scope, self)).rejects.toMatchObject({
      reason: 'COAUTH_REQUIRED',
    });
  });

  it('refuses a solo self-witness whose own PIN is wrong, without marking the transaction', async () => {
    mocks.soloOwnerApprovalAllowed.mockResolvedValue(true);

    await expect(
      authorizeWriteOffWitness(scoped(), scope, { ...self, witnessPin: '9999' })
    ).rejects.toMatchObject({ reason: 'COAUTH_REQUIRED' });
    expect(markerSet()).toBe(false);
  });

  it('audits the PIN-verified self-witness against the movement', async () => {
    await recordWriteOffWitnessEvidence(
      scoped(),
      scope,
      { witnessId: scope.actorId, soloSelfWitness: true, policy: 'PHARMACY_SOLO_OWNER_PIN' },
      'movement_1'
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org_a',
        actorId: 'user_actor',
        action: 'pharmacy.writeOffSoloSelfWitness',
        targetType: 'PharmacyStockMovement',
        targetId: 'movement_1',
        metadata: {
          branchId: 'branch_a',
          witnessId: 'user_actor',
          pinVerified: true,
          policy: 'PHARMACY_SOLO_OWNER_PIN',
        },
      }),
    });
  });
});

describe('writeOffWitnessOptions', () => {
  it('lists only colleagues assigned to the branch with a live PIN', async () => {
    db.user.findMany.mockResolvedValue([{ id: 'user_witness', name: 'Witness', title: null }]);

    await expect(writeOffWitnessOptions(scoped(), scope)).resolves.toEqual({
      witnesses: [{ id: 'user_witness', name: 'Witness', title: null }],
      soloSelfWitness: false,
    });
    expect(db.user.findMany).toHaveBeenCalledWith({
      where: {
        ...assignedToBranch,
        id: { not: scope.actorId },
        restaurantStaffProfiles: {
          some: {
            organizationId: 'org_a',
            status: 'ACTIVE',
            credentials: { some: { type: 'PIN', revokedAt: null, deviceId: null } },
          },
        },
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, title: true },
    });
  });

  it('offers the solo owner themself when nobody else can witness', async () => {
    mocks.soloOwnerApprovalAllowed.mockResolvedValue(true);

    await expect(writeOffWitnessOptions(scoped(), scope)).resolves.toEqual({
      witnesses: [],
      soloSelfWitness: true,
    });
  });

  it('offers nobody when an assigned colleague exists but has no PIN yet', async () => {
    db.user.count.mockResolvedValue(1);
    mocks.soloOwnerApprovalAllowed.mockResolvedValue(true);

    await expect(writeOffWitnessOptions(scoped(), scope)).resolves.toEqual({
      witnesses: [],
      soloSelfWitness: false,
    });
  });
});
