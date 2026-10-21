import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  appendControlledCorrection: vi.fn(),
  can: vi.fn(),
  verifyOperatorCredential: vi.fn(),
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/tenancy/scoped-db', () => ({ createTenantDb: vi.fn() }));
vi.mock('@/lib/tenancy/tenant-actor', () => ({ resolveTenantActor: vi.fn() }));
vi.mock('@/lib/abac', () => ({ can: mocks.can, subjectFromSession: (user: unknown) => user }));
vi.mock('@/lib/pharmacy/controlled-register', () => ({
  appendControlledCorrection: mocks.appendControlledCorrection,
  assignedRegisterBranchIds: vi.fn(async () => ['branch_a']),
  listControlledPinWitnesses: vi.fn(async () => []),
}));
vi.mock('@/lib/restaurant/operator-credentials', () => ({
  clearLockout: vi.fn(() => ({ failedAttempts: 0, lockedUntil: null })),
  isLockedOut: vi.fn(() => false),
  registerFailedAttempt: vi.fn(),
  verifyOperatorCredential: mocks.verifyOperatorCredential,
}));

import { pharmacySafetyRouter } from './pharmacy-safety';
import type { TRPCContext } from '../trpc';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.can.mockResolvedValue(true);
  mocks.verifyOperatorCredential.mockResolvedValue(true);
});

describe('pharmacy safety register procedures', () => {
  it('does not expose a direct recordControlledEntry mutation', () => {
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).not.toContain(
      'recordControlledEntry'
    );
    expect(Object.keys(pharmacySafetyRouter._def.procedures)).toEqual(
      expect.arrayContaining(['controlledRegister', 'recordCorrection', 'branches', 'access'])
    );
  });

  it('records a correction with a newly verified qualified witness', async () => {
    const credential = {
      id: 'credential_fresh',
      credentialHash: 'stored-hash',
      failedAttempts: 0,
      lockedUntil: null,
      staffProfile: {
        status: 'ACTIVE',
        user: { id: 'witness_fresh', organizationId: 'org_a', status: 'ACTIVE' },
      },
    };
    const db = {
      pharmacyBranchAssignment: { findMany: vi.fn(async () => [{ branchId: 'branch_a' }]) },
      pharmacyBranch: { findFirst: vi.fn(async () => ({ id: 'branch_a' })) },
      restaurantOperatorCredential: {
        findFirst: vi.fn(async () => credential),
        update: vi.fn(async () => credential),
      },
      $queryRaw: vi.fn(),
    };
    Object.assign(db, {
      $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
    });
    mocks.appendControlledCorrection.mockResolvedValue({ id: 'correction_a' });
    const caller = pharmacySafetyRouter.createCaller({
      db,
      entitlements: { organizationId: 'org_a' },
      session: { user: { id: 'actor_a', status: 'ACTIVE' } },
      requestMeta: { ip: null, userAgent: null },
      audit: { detail: {} },
    } as unknown as TRPCContext);

    await caller.recordCorrection({
      branchId: 'branch_a',
      correctsEntryId: 'original_entry',
      correctionReason: 'Corrected count',
      quantityCanonicalUnits: 2,
      staffProfileId: 'staff_fresh',
      pin: '1234',
    });

    expect(mocks.verifyOperatorCredential).toHaveBeenCalledWith('PIN', '1234', 'stored-hash');
    expect(mocks.can).toHaveBeenCalledWith(
      credential.staffProfile.user,
      'pharmacy:dispense',
      undefined,
      expect.objectContaining({ db })
    );
    expect(mocks.appendControlledCorrection).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        correctsEntryId: 'original_entry',
        recordedByUserId: 'actor_a',
        witnessedByUserId: 'witness_fresh',
        signatureRef: 'pin:witness_fresh',
      })
    );
  });
});
