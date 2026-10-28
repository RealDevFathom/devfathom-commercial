import { rateLimit, clearRateLimit } from '@/lib/rate-limit';
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
  const rows = await db.$queryRaw<Array<{ allowed: boolean }>>`
    SELECT pharmacy_solo_owner_eligible(${scope.organizationId}, ${scope.branchId ?? null}, ${scope.actorId}) AS allowed`;
  return rows?.[0]?.allowed === true;
}

/** Verifies a live user PIN with durable, serialized credential lockout state. */
export async function verifyPharmacyUserPin(
  scope: { organizationId: string; actorId: string },
  pin?: string
): Promise<boolean> {
  const { organizationId, actorId } = scope;
  if (!pin || !/^\d{4,8}$/.test(pin)) return false;
  if (!(await rateLimit(`pharmacy:solo-owner-pin:${organizationId}:${actorId}`, 5, 15 * 60_000)).ok)
    return false;
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
  if (valid) await clearRateLimit(`pharmacy:solo-owner-pin:${organizationId}:${actorId}`);
  return valid;
}

/** Eligibility must precede PIN verification and any success evidence. */
export async function verifySoloOwnerPin(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string | null; actorId: string },
  pin?: string
): Promise<boolean> {
  if (!pin || !/^\d{4,8}$/.test(pin)) return false;
  if (!(await soloOwnerEligible(db, scope))) return false;
  return verifyPharmacyUserPin(scope, pin);
}

/** Approval evidence must commit or roll back with the document. Never persists the PIN. */
export async function authorizeSoloApproval(
  db: ScopedDb,
  scope: { organizationId: string; branchId: string | null; actorId: string },
  target: { type: string; id: string },
  pin?: string
): Promise<boolean> {
  if (!(await verifySoloOwnerPin(db, scope, pin))) return false;
  const { organizationId, branchId, actorId } = scope;
  const audit = await db.auditLog.create({
    data: {
      organizationId,
      actorId,
      source: 'TRPC',
      category: 'PHARMACY',
      action: SOLO_APPROVAL_POLICY,
      targetType: target.type,
      targetId: target.id,
      metadata: {
        branchId,
        policy: SOLO_APPROVAL_POLICY,
        reauthentication: 'PIN',
        activeStaffCount: 1,
      },
    },
  });
  await db.$queryRaw`SELECT set_config('app.pharmacy_solo_audit_id', ${audit.id}, true)`;
  return true;
}
