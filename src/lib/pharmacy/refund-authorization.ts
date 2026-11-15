import { can, subjectFromSession } from '@/lib/abac';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-647: only a manager or owner may refund, and only after re-entering their
 * own PIN. `pharmacy:manage` is held by the Manager, Owner (`pharmacy:*`),
 * Owner / Operator and Administrator (`*`) roles, never by Cashier or Pharmacist.
 * A solo owner meets the rule with their own fresh PIN; the request audit row
 * records the policy and the verification.
 */
export const REFUND_PIN_POLICY = 'PHARMACY_REFUND_MANAGER_PIN';
export const REFUND_FORBIDDEN = 'Only a manager or owner can refund.';
export const REFUND_PIN_BLOCKED = 'Refund not recorded. Enter your manager or owner PIN.';

export function actorMayRefund(
  db: ScopedDb,
  actor: { id: string; role?: string | null; department?: string | null; status?: string | null },
  now = new Date()
): Promise<boolean> {
  return can(subjectFromSession(actor), 'pharmacy:manage', undefined, {
    db,
    now,
    source: 'TRPC',
  });
}

/**
 * Re-authenticates the signed-in manager or owner with their own staff PIN.
 * Runs in its own tenant transaction, so a refused PIN commits the lockout
 * strike even when the request's transaction later rolls back. Returns (never
 * throws) a refusal.
 */
export function verifyRefundPin(
  input: { organizationId: string; actorId: string; pin: string },
  now = new Date()
): Promise<{ verified: true } | { blocked: string }> {
  return withTenantDb(input.organizationId, (db) => checkRefundPin(db, input, now), {
    skipDrain: true,
  });
}

async function checkRefundPin(
  db: ScopedDb,
  input: { organizationId: string; actorId: string; pin: string },
  now: Date
): Promise<{ verified: true } | { blocked: string }> {
  const { organizationId, actorId, pin } = input;
  if (!/^\d{4,8}$/.test(pin)) return { blocked: REFUND_PIN_BLOCKED };
  // Serialize strikes for simultaneous attempts on the same credential.
  await db.$queryRaw`SELECT c.id FROM restaurant_operator_credentials c JOIN restaurant_staff_profiles s ON s.id=c."staffProfileId" AND s."organizationId"=c."organizationId" WHERE c."organizationId"=${organizationId} AND s."userId"=${actorId} AND c.type='PIN' AND c."revokedAt" IS NULL AND c."deviceId" IS NULL ORDER BY c.id FOR UPDATE OF c`;
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
  if (!credential || isLockedOut(credential, now)) return { blocked: REFUND_PIN_BLOCKED };
  if (!(await verifyOperatorCredential('PIN', pin, credential.credentialHash))) {
    await db.restaurantOperatorCredential.update({
      where: { id: credential.id },
      data: registerFailedAttempt(credential, now),
    });
    return { blocked: REFUND_PIN_BLOCKED };
  }
  await db.restaurantOperatorCredential.update({
    where: { id: credential.id },
    data: clearLockout(),
  });
  return { verified: true };
}
