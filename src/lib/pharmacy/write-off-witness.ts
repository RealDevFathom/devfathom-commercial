import { can } from '@/lib/abac';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

import {
  isSolePharmacist,
  SOLO_PHARMACIST_WITNESS_POLICY,
} from './controlled-restoration-authorization';
import { PharmacyInventoryError } from './inventory';
import { SOLO_OWNER_POLICY, soloOwnerApprovalAllowed } from './purchase-approval';
import type { LedgerScope } from './stock-ledger';

/** Audit policy for a write-off a second person confirmed with their own PIN. */
export const WRITE_OFF_WITNESS_PIN_POLICY = 'PHARMACY_WRITE_OFF_WITNESS_PIN';

export type WriteOffWitnessPin = { witnessId: string; witnessPin: string };
export type WriteOffWitness = {
  witnessId: string;
  /** True when a solo owner or sole pharmacist witnessed with their own fresh PIN. */
  soloSelfWitness: boolean;
  policy: string;
};
export type WriteOffWitnessOption = { id: string; name: string | null; title: string | null };

/** The only people the write-off paths accept: active members assigned to the branch. */
function branchMember(scope: LedgerScope) {
  return {
    organizationId: scope.organizationId,
    status: 'ACTIVE' as const,
    pharmacyBranchAssignments: {
      some: { organizationId: scope.organizationId, branchId: scope.branchId, active: true },
    },
  };
}

const LIVE_PIN = { type: 'PIN' as const, revokedAt: null, deviceId: null };

/**
 * Solo-pharmacy rule: with nobody else assigned to the branch, a solo owner or
 * the sole pharmacist witnesses their own write-off with a fresh PIN. Anyone
 * else at the branch, with or without a PIN, ends the exception. Returns the
 * audit policy that applies, or null when a second person is required.
 */
async function soloSelfWitnessPolicy(db: ScopedDb, scope: LedgerScope): Promise<string | null> {
  const others = await db.user.count({
    where: { ...branchMember(scope), id: { not: scope.actorId } },
  });
  if (others > 0) return null;
  if (await soloOwnerApprovalAllowed(db, scope.organizationId, scope.actorId, scope.branchId))
    return SOLO_OWNER_POLICY;
  const actor = await db.user.findFirst({
    where: { id: scope.actorId, organizationId: scope.organizationId, status: 'ACTIVE' },
  });
  if (
    actor &&
    (await can(actor, 'pharmacy:dispense', undefined, { db })) &&
    (await isSolePharmacist(db, scope.organizationId, scope.actorId))
  )
    return SOLO_PHARMACIST_WITNESS_POLICY;
  return null;
}

/**
 * Who the write-off forms may offer as witness: exactly the people
 * `authorizeWriteOffWitness` would accept. Colleagues assigned to the branch
 * with a PIN set up; or, under the solo-pharmacy rule, the actor themself.
 */
export async function writeOffWitnessOptions(
  db: ScopedDb,
  scope: LedgerScope
): Promise<{ witnesses: WriteOffWitnessOption[]; soloSelfWitness: boolean }> {
  const witnesses = await db.user.findMany({
    where: {
      ...branchMember(scope),
      id: { not: scope.actorId },
      restaurantStaffProfiles: {
        some: {
          organizationId: scope.organizationId,
          status: 'ACTIVE',
          credentials: { some: LIVE_PIN },
        },
      },
    },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, title: true },
  });
  if (witnesses.length > 0) return { witnesses, soloSelfWitness: false };
  return { witnesses: [], soloSelfWitness: (await soloSelfWitnessPolicy(db, scope)) !== null };
}

/** Runs in its own tenant transaction so a refused PIN's strike is never rolled back. */
async function verifyWitnessPin(
  db: ScopedDb,
  scope: LedgerScope,
  input: WriteOffWitnessPin
): Promise<boolean> {
  // Serialize strikes even for simultaneous guesses of the same person's PIN.
  await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" WHERE c."organizationId"=${scope.organizationId} AND s."organizationId"=${scope.organizationId} AND s."userId"=${input.witnessId} AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL ORDER BY c.id FOR UPDATE OF c`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId: scope.organizationId,
      ...LIVE_PIN,
      staffProfile: {
        organizationId: scope.organizationId,
        userId: input.witnessId,
        status: 'ACTIVE',
        user: { organizationId: scope.organizationId, status: 'ACTIVE' },
      },
    },
    orderBy: { id: 'asc' },
  });
  const now = new Date();
  if (!credential || isLockedOut(credential, now)) return false;
  if (
    !(await verifyApprovalSecret(db, {
      organizationId: scope.organizationId,
      approverUserId: input.witnessId,
      credentialHash: credential.credentialHash,
      secret: input.witnessPin,
      action: 'pharmacy.writeOffWitness',
      requestedById: scope.actorId,
      now,
    }))
  ) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return false;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  return true;
}

/**
 * The two-person stock-loss control. The named witness must be an active member
 * assigned to the branch and must confirm with their own PIN, entered at the
 * point of write-off. Naming yourself is accepted only under the solo-pharmacy
 * rule, and still needs your fresh PIN. Every refusal is `COAUTH_REQUIRED`.
 */
export async function authorizeWriteOffWitness(
  db: ScopedDb,
  scope: LedgerScope,
  input: WriteOffWitnessPin
): Promise<WriteOffWitness> {
  if (!/^\d{4,8}$/.test(input.witnessPin)) throw new PharmacyInventoryError('COAUTH_REQUIRED');
  const soloSelfWitness = input.witnessId === scope.actorId;
  let policy = WRITE_OFF_WITNESS_PIN_POLICY;
  if (soloSelfWitness) {
    const solo = await soloSelfWitnessPolicy(db, scope);
    if (!solo) throw new PharmacyInventoryError('COAUTH_REQUIRED');
    policy = solo;
  } else {
    const witness = await db.user.findFirst({
      where: { ...branchMember(scope), id: input.witnessId },
      select: { id: true },
    });
    if (!witness) throw new PharmacyInventoryError('COAUTH_REQUIRED');
  }
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const verified = await withTenantDb(
    scope.organizationId,
    (credentialDb) => verifyWitnessPin(credentialDb, scope, input),
    { userId: scope.actorId, skipDrain: true }
  );
  // Thrown only after the credential transaction has committed any strike.
  if (!verified) throw new PharmacyInventoryError('COAUTH_REQUIRED');
  // The custody table refuses actor = witness unless this transaction-local
  // marker names the actor, so only a PIN-verified solo self-witness passes.
  if (soloSelfWitness)
    await db.$queryRaw`SELECT set_config('app.pharmacy_write_off_solo_witness_user_id', ${scope.actorId}, true)`;
  return { witnessId: input.witnessId, soloSelfWitness, policy };
}

/** Durable proof, in the write-off's own transaction, that the witness entered a PIN. */
export async function recordWriteOffWitnessEvidence(
  db: ScopedDb,
  scope: LedgerScope,
  witness: WriteOffWitness,
  movementId: string
) {
  return db.auditLog.create({
    data: {
      organizationId: scope.organizationId,
      actorId: scope.actorId,
      actorType: 'USER',
      source: 'TRPC',
      category: 'PHARMACY_INVENTORY',
      operation: 'OTHER',
      action: witness.soloSelfWitness
        ? 'pharmacy.writeOffSoloSelfWitness'
        : 'pharmacy.writeOffWitnessConfirmed',
      targetType: 'PharmacyStockMovement',
      targetId: movementId,
      metadata: {
        branchId: scope.branchId,
        witnessId: witness.witnessId,
        pinVerified: true,
        policy: witness.policy,
      },
    },
  });
}
