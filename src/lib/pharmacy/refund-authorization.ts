import { can, subjectFromSession } from '@/lib/abac';
import {
  clearLockout,
  isLockedOut,
  registerFailedAttempt,
  verifyOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  CredentialLifecycleError,
  issueOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';

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
 * Returns (never throws) a refusal so the caller's transaction commits the
 * lockout strike.
 */
export async function verifyRefundPin(
  db: ScopedDb,
  input: { organizationId: string; actorId: string; pin: string },
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
            errorCode: 'REFUND_PIN_REFUSED',
            metadata: { policy: REFUND_PIN_POLICY, pinVerified: false },
          },
        });
      return result;
    },
    { skipDrain: true }
  );
}

/** DEV-645: true when the actor has an active, organization-wide staff PIN to approve refunds. */
export async function hasRefundPin(
  db: ScopedDb,
  organizationId: string,
  actorId: string
): Promise<boolean> {
  const credential = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId,
      type: 'PIN',
      revokedAt: null,
      deviceId: null,
      staffProfile: { organizationId, userId: actorId, status: 'ACTIVE' },
    },
    select: { id: true },
  });
  return credential !== null;
}

export const REFUND_PIN_EXISTS =
  'You already have a staff PIN. Ask your administrator to change it.';

export class RefundPinSetupError extends Error {
  constructor(
    message: string,
    readonly reason: 'ALREADY_EXISTS' | 'PROFILE_INACTIVE'
  ) {
    super(message);
    this.name = 'RefundPinSetupError';
  }
}

/**
 * DEV-645: first PIN for a manager or owner who has none, so a counter-only pharmacy (no
 * procurement or restaurant staff module, which hold the other PIN setup paths) can still
 * refund. It never replaces an existing PIN: changing one stays with the administrator.
 * The caller checks `actorMayRefund` and supplies one tenant transaction.
 */
export async function provisionRefundPin(
  db: ScopedDb,
  input: { organizationId: string; userId: string; displayName: string; pin: string }
): Promise<{ id: string; staffProfileId: string }> {
  const { organizationId, userId } = input;
  // Serialize first-time profile and credential creation for this person.
  await db.$queryRaw`SELECT id FROM users WHERE id=${userId} AND "organizationId"=${organizationId} FOR UPDATE`;
  const prior = await db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId,
      type: 'PIN',
      deviceId: null,
      staffProfile: { organizationId, userId },
    },
    select: { id: true },
  });
  if (prior) throw new RefundPinSetupError(REFUND_PIN_EXISTS, 'ALREADY_EXISTS');
  let profile = await db.restaurantStaffProfile.findFirst({
    where: { organizationId, userId },
    orderBy: { id: 'asc' },
  });
  if (profile && profile.status !== 'ACTIVE')
    throw new RefundPinSetupError(
      'Ask your administrator to activate your staff profile.',
      'PROFILE_INACTIVE'
    );
  profile ??= await db.restaurantStaffProfile.create({
    data: { organizationId, userId, displayName: input.displayName },
  });
  try {
    const credential = await issueOperatorCredential(db, {
      staffProfileId: profile.id,
      type: 'PIN',
      secret: input.pin,
    });
    return { id: credential.id, staffProfileId: profile.id };
  } catch (error) {
    if (error instanceof CredentialLifecycleError && error.reason === 'ALREADY_EXISTS')
      throw new RefundPinSetupError(REFUND_PIN_EXISTS, 'ALREADY_EXISTS');
    throw error;
  }
}
