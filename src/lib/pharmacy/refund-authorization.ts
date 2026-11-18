import { can, subjectFromSession } from '@/lib/abac';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
} from '@/lib/restaurant/operator-credentials';
import { verifyApprovalSecret } from '@/lib/approval-authenticator';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';

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
/** DEV-621: a sale return restocks stock and posts the refund liability, so it needs the same approval. */
export const RETURN_FORBIDDEN = 'Only a manager or owner can record a return.';
export const RETURN_PIN_BLOCKED = 'Enter your manager or owner PIN.';

/**
 * DEV-32: the approval detail written to a refund's or return's audit record. The
 * signed-in manager or owner both starts the refund and approves it with their own
 * fresh PIN, so the record names who started it, who approved it, when the PIN was
 * accepted, and that this was a self-approval. A refused PIN has no approval time and
 * is never recorded as approved.
 */
export function refundApprovalAudit(input: {
  initiatedById: string;
  approverId: string;
  pin: { verified: true } | { blocked: string };
  now?: Date;
}): {
  policy: typeof REFUND_PIN_POLICY;
  approverId: string;
  initiatedById: string;
  pinVerified: boolean;
  selfApproved: boolean;
  approvedAt: string | null;
} {
  const verified = 'verified' in input.pin;
  return {
    policy: REFUND_PIN_POLICY,
    approverId: input.approverId,
    initiatedById: input.initiatedById,
    pinVerified: verified,
    selfApproved: verified && input.approverId === input.initiatedById,
    approvedAt: verified ? (input.now ?? new Date()).toISOString() : null,
  };
}

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
 * Returns (never throws) a refusal so the caller's transaction commits the
 * lockout strike.
 */
export async function verifyRefundPin(
  db: ScopedDb,
  input: { organizationId: string; actorId: string; pin: string; action?: string },
  now = new Date()
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
  if (
    !(await verifyApprovalSecret(db, {
      organizationId,
      approverUserId: actorId,
      credentialHash: credential.credentialHash,
      secret: pin,
      action: input.action ?? 'pharmacy.refund',
      requestedById: actorId,
      now,
    }))
  ) {
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

/**
 * verifyRefundPin in its own tenant transaction. The request transaction rolls
 * back when any procedure in a tRPC batch fails, which would also discard a
 * lockout strike; this one commits before any refund work starts. A refused PIN
 * also commits a FAILURE audit row here: the request audit would otherwise
 * record the blocked refund as a successful mutation.
 */
export function authenticateRefundPin(input: {
  organizationId: string;
  actorId: string;
  pin: string;
  /** The refunding procedure, for the audit row. */
  action: string;
  /** DEV-881: another manager-PIN control reusing this check names its own policy. */
  policy?: string;
  errorCode?: string;
}): Promise<{ verified: true } | { blocked: string }> {
  return withTenantDb(
    input.organizationId,
    async (db) => {
      const result = await verifyRefundPin(db, input);
      if ('blocked' in result)
        await db.auditLog.create({
          data: {
            organizationId: input.organizationId,
            actorId: input.actorId,
            source: 'TRPC',
            category: 'PHARMACY',
            operation: 'EXECUTE',
            action: input.action,
            outcome: 'FAILURE',
            errorCode: input.errorCode ?? 'REFUND_PIN_REFUSED',
            metadata: { policy: input.policy ?? REFUND_PIN_POLICY, pinVerified: false },
          },
        });
      return result;
    },
    { skipDrain: true }
  );
}
