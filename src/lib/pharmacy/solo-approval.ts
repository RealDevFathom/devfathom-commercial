import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  verifyOperatorCredential,
  isLockedOut,
  registerFailedAttempt,
  clearLockout,
} from '@/lib/restaurant/operator-credentials';

export const SOLO_APPROVAL_POLICY = 'PHARMACY:SOLO_OWNER_PIN';

/** Identity lookup only; credential security state is read only after its lock. */
export async function pinProfileBelongsToActor(
  db: ScopedDb,
  scope: { organizationId: string; actorId: string },
  staffProfileId: string
) {
  const profiles = await db.$queryRaw<Array<{ userId: string | null }>>`
    SELECT "userId" FROM restaurant_staff_profiles WHERE "organizationId"=${scope.organizationId} AND id=${staffProfileId}`;
  return profiles?.[0]?.userId === scope.actorId;
}

export async function soloOwnerEligible(
  db: ScopedDb,
  scope: { organizationId: string; branchId?: string | null; actorId: string }
) {
  const actor = await db.user.findUnique({
    where: { id: scope.actorId, organizationId: scope.organizationId },
    select: {
      status: true,
      role: true,
      organizationId: true,
      organizationRole: { select: { key: true } },
    },
  });
  if (
    actor?.status !== 'ACTIVE' ||
    actor.organizationId !== scope.organizationId ||
    (actor.role !== 'ADMIN' && actor.organizationRole?.key !== 'owner')
  )
    return false;
  const rows = await db.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT pharmacy_solo_owner_eligible(${scope.organizationId}, ${scope.branchId ?? null}, ${scope.actorId}) AS allowed`;
  return rows?.[0]?.allowed === true;
}

/** Runs in the same transaction as the document. Never persists the PIN. */
export async function authorizeSoloApproval(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string | null; actorId: string },
  target: { type: string; id: string },
  pin?: string
): Promise<boolean> {
  const { organizationId, branchId, actorId } = scope;
  if (!pin || !/^\d{4,8}$/.test(pin)) return false;
  // The database guard repeats eligibility when the document changes.
  const eligible = await db.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT pharmacy_solo_owner_eligible(${organizationId}, ${branchId}, ${actorId}) AS allowed`;
  if (!eligible?.[0]?.allowed || !pin) return false;
  // Failed attempts must survive rollback of the purchasing request. This
  // small independent transaction owns only the credential lock/counters.
  const { withTenantDb } = await import('@/lib/tenancy/scoped-db');
  const valid = await withTenantDb(
    organizationId,
    async (db) => {
      await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c
    JOIN restaurant_staff_profiles p ON p.id=c."staffProfileId" AND p."organizationId"=c."organizationId"
    WHERE c."organizationId"=${organizationId} AND p."userId"=${actorId}
      AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL FOR UPDATE OF c`;
      const current = await db.restaurantOperatorCredential.findFirst({
        where: {
          organizationId,
          type: 'PIN',
          revokedAt: null,
          deviceId: null,
          staffProfile: {
            organizationId,
            userId: actorId,
            status: 'ACTIVE',
            user: { organizationId, status: 'ACTIVE' },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!current || current.revokedAt || isLockedOut(current, new Date())) return false;
      const valid = await verifyOperatorCredential('PIN', pin, current.credentialHash);
      await db.restaurantOperatorCredential.update({
        where: { id: current.id },
        data: valid ? clearLockout() : registerFailedAttempt(current, new Date()),
      });
      return valid;
    },
    { userId: actorId, skipDrain: true }
  );
  if (!valid) return false;
  const audit = await db.auditLog.create({
    data: {
      organizationId,
      actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      action: SOLO_APPROVAL_POLICY,
      targetType: target.type,
      targetId: target.id,
      metadata: { branchId, policy: SOLO_APPROVAL_POLICY, reauthentication: 'PIN' },
    },
  });
  await db.$queryRaw`SELECT set_config('app.pharmacy_solo_audit_id', ${audit.id}, true)`;
  return true;
}
