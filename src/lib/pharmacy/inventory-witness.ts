import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

const REFUSAL = 'A different branch colleague must enter their PIN to co-authorize this write-off.';
type WitnessScope = { organizationId: string; branchId: string; actorId: string };
type WitnessInput = { staffProfileId: string; pin: string };

/** PIN counters must survive an unrelated failure in the outer HTTP batch. */
export function authenticateInventoryWitness(scope: WitnessScope, input: WitnessInput) {
  return withTenantDb(scope.organizationId, (db) => verifyInventoryWitness(db, scope, input), {
    userId: scope.actorId,
    timeout: 10_000,
  });
}

export async function listInventoryWitnesses(
  db: ScopedDb,
  organizationId: string,
  branchId: string,
  actorId: string
) {
  return db.restaurantStaffProfile.findMany({
    where: {
      organizationId,
      status: 'ACTIVE',
      userId: { not: actorId },
      user: {
        organizationId,
        status: 'ACTIVE',
        pharmacyBranchAssignments: { some: { organizationId, branchId, active: true } },
      },
      credentials: {
        some: {
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }],
        },
      },
    },
    orderBy: { displayName: 'asc' },
    select: { id: true, displayName: true },
  });
}

/** Authenticate the second person before any stock mutation is attempted. */
export async function verifyInventoryWitness(
  db: ScopedDb,
  scope: WitnessScope,
  input: WitnessInput
): Promise<{ witnessId: string } | { blocked: string }> {
  await db.$queryRaw`SELECT id FROM restaurant_operator_credentials WHERE "organizationId"=${scope.organizationId} AND "staffProfileId"=${input.staffProfileId} AND type='PIN' AND "revokedAt" IS NULL AND "deviceId" IS NULL FOR UPDATE`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      staffProfileId: input.staffProfileId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
    },
    include: {
      staffProfile: { include: { user: { include: { pharmacyBranchAssignments: true } } } },
    },
  });
  const user = credential?.staffProfile.user;
  const now = new Date();
  const assigned = user?.pharmacyBranchAssignments.some(
    (row) =>
      row.organizationId === scope.organizationId && row.branchId === scope.branchId && row.active
  );
  if (
    !credential ||
    !user ||
    credential.staffProfile.organizationId !== scope.organizationId ||
    credential.staffProfile.status !== 'ACTIVE' ||
    user.organizationId !== scope.organizationId ||
    user.status !== 'ACTIVE' ||
    user.id === scope.actorId ||
    !assigned ||
    isLockedOut(credential, now)
  ) {
    return { blocked: REFUSAL };
  }
  if (!(await verifyOperatorCredential('PIN', input.pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return { blocked: REFUSAL };
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  return { witnessId: user.id };
}
