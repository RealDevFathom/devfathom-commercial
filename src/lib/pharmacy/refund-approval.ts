import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  clearLockout,
  isLockedOut,
  isValidPinFormat,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';

/** Audit policy name for a refund approved by the signed-in manager or owner's own PIN. */
export const REFUND_APPROVAL_POLICY = 'PHARMACY_REFUND_MANAGER_PIN';

export type RefundApproval = { staffProfileId: string; pinReauthenticatedAt: Date };

/**
 * DEV-645: fresh PIN re-authentication of the signed-in manager or owner. The PIN is
 * the actor's own staff operator credential, so a sole owner approves their own refund.
 */
async function verifyActorPin(
  db: ScopedDb,
  organizationId: string,
  actorId: string,
  pin: string,
  now: Date
): Promise<RefundApproval | null> {
  if (!isValidPinFormat(pin)) return null;
  // Serialize strikes for simultaneous guesses of the same user's PIN.
  await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" WHERE c."organizationId"=${organizationId} AND s."organizationId"=${organizationId} AND s."userId"=${actorId} AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL ORDER BY c.id FOR UPDATE OF c`;
  const credential = await db.restaurantOperatorCredential.findFirst({
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
    orderBy: { id: 'asc' },
  });
  if (!credential || isLockedOut(credential, now)) return null;
  if (!(await verifyOperatorCredential('PIN', pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return null;
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  return { staffProfileId: credential.staffProfileId, pinReauthenticatedAt: now };
}

/**
 * Runs in its own tenant transaction: a refused refund rolls back the request, but a
 * wrong PIN must still count toward the credential lockout.
 */
export function verifyRefundApproverPin(
  organizationId: string,
  actorId: string,
  pin: string,
  now = new Date()
): Promise<RefundApproval | null> {
  return withTenantDb(
    organizationId,
    (db) => verifyActorPin(db, organizationId, actorId, pin, now),
    { skipDrain: true, userId: actorId }
  );
}
