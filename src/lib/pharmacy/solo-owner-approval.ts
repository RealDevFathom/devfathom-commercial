import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { can, type Action } from '@/lib/abac';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

/** Must run in the transaction which writes the approval. PIN failures must commit. */
export async function authorizeSoloOwnerApproval(
  db: ScopedDb,
  input: {
    organizationId: string;
    actorId: string;
    targetId: string;
    capability: Action;
    pin?: string;
    branchId?: string;
    staffProfileId?: string;
  }
): Promise<boolean> {
  const { organizationId, actorId, targetId, capability, pin, branchId, staffProfileId } = input;
  if (!pin || !/^\d{4,8}$/.test(pin)) return false;
  // Serialize approvals with tenant user membership changes (also enforced in SQL).
  await db.$queryRaw`SELECT id FROM organizations WHERE id=${organizationId} FOR UPDATE`;
  const eligibility = await db.$queryRaw<
    { allowed: boolean }[]
  >`SELECT pharmacy_is_solo_owner(${organizationId}, ${actorId}, ${branchId ?? null}) AS allowed`;
  if (!eligibility?.[0]?.allowed) return false;
  const actor = await db.user.findFirst({
    where: { id: actorId, organizationId, status: 'ACTIVE' },
  });
  if (!actor || !(await can(actor, capability, undefined, { db }))) return false;
  await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" WHERE c."organizationId"=${organizationId} AND s."organizationId"=${organizationId} AND s."userId"=${actorId} AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL FOR UPDATE OF c`;
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId,
      ...(staffProfileId ? { staffProfileId } : {}),
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: { organizationId, userId: actorId, status: 'ACTIVE' },
    },
  });
  const now = new Date();
  if (!credential || isLockedOut(credential, now)) return false;
  if (!(await verifyOperatorCredential('PIN', pin, credential.credentialHash))) {
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
  const [transaction] = await db.$queryRaw<{ id: string }[]>`SELECT txid_current()::text AS id`;
  await db.auditLog.create({
    data: {
      organizationId,
      actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      action: 'pharmacy.soloOwnerApproval',
      targetType: 'PharmacyApproval',
      targetId,
      metadata: {
        policy: 'SOLO_OWNER_PIN',
        capability,
        transactionId: transaction.id,
        credentialId: credential.id,
        branchId: branchId ?? null,
      },
    },
  });
  return true;
}

/** Eligibility for UI only; mutations must recheck under the membership lock. */
export async function isSoloPharmacyOwner(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  branchId?: string
) {
  const rows = await db.$queryRaw<
    { allowed: boolean }[]
  >`SELECT pharmacy_is_solo_owner(${organizationId}, ${actorId}, ${branchId ?? null}) AS allowed`;
  return rows?.[0]?.allowed === true;
}
