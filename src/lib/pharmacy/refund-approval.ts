import 'server-only';

import { withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  CredentialLifecycleError,
  issueOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';
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

/** True when the actor has an active, organization-wide staff PIN that can approve refunds. */
export async function hasRefundApprovalPin(
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

export class RefundPinProvisionError extends Error {
  constructor(
    message: string,
    readonly reason: 'ALREADY_EXISTS' | 'PROFILE_INACTIVE'
  ) {
    super(message);
    this.name = 'RefundPinProvisionError';
  }
}

/**
 * First-time PIN for a manager or owner with no staff PIN yet, so a counter-only pharmacy
 * (no procurement or restaurant staff module) can still approve refunds. It never replaces
 * an existing PIN: rotation stays with the administrator. The caller checks authorization
 * and supplies one tenant transaction.
 */
export async function provisionRefundApprovalPin(
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
  if (prior)
    throw new RefundPinProvisionError(
      'You already have a staff PIN. Ask your administrator to change it.',
      'ALREADY_EXISTS'
    );
  let profile = await db.restaurantStaffProfile.findFirst({
    where: { organizationId, userId },
    orderBy: { id: 'asc' },
  });
  if (profile && profile.status !== 'ACTIVE')
    throw new RefundPinProvisionError(
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
      throw new RefundPinProvisionError(
        'You already have a staff PIN. Ask your administrator to change it.',
        'ALREADY_EXISTS'
      );
    throw error;
  }
}
