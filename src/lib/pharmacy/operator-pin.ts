import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { can } from '@/lib/abac';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import {
  CredentialPolicyError,
  hashOperatorCredential,
} from '@/lib/restaurant/operator-credentials';
import { verifyLostDemandPin } from './lost-demand-operations';

/**
 * Pharmacy owner/manager PIN enrolment. The PIN is stored only as the salted
 * slow hash on the shared operator-credential row that the lost-demand
 * approval boundary verifies (`verifyLostDemandPin`). This path deliberately
 * does not depend on the restaurant staff console or the `restaurant-core`
 * module, so a pharmacy-only tenant can enrol the PIN its approvals require.
 *
 * The plaintext PIN is never returned, logged or written to an audit row.
 */

export const PHARMACY_PIN_ENROLMENT_CAPABILITY = 'pharmacy:manage' as const;

export class PharmacyPinEnrolmentError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'FORBIDDEN'
      | 'TARGET_NOT_ELIGIBLE'
      | 'CURRENT_PIN_REQUIRED'
      | 'CURRENT_PIN_INVALID'
      | 'PROFILE_INACTIVE'
      | 'INVALID_PIN'
  ) {
    super(message);
    this.name = 'PharmacyPinEnrolmentError';
  }
}

export type PharmacyPinActor = {
  organizationId: string;
  userId: string;
  /** Session role; only an owner (ADMIN) may reset another owner/manager's PIN. */
  role: string;
};

export type PharmacyPinEnrolmentInput = {
  /** Defaults to the actor. */
  targetUserId?: string;
  pin: string;
  /** Required when a non-owner changes their own existing PIN. */
  currentPin?: string;
};

type EligibleUser = {
  id: string;
  name: string;
  status: string;
  role: string;
  department?: string | null;
};

async function eligibleOwnerOrManager(
  db: ScopedDb,
  organizationId: string,
  userId: string
): Promise<EligibleUser | null> {
  const user = await db.user.findFirst({
    where: { id: userId, organizationId },
    select: { id: true, name: true, status: true, role: true, department: true },
  });
  if (!user || !ACTIVE_STATUSES.has(user.status)) return null;
  // Owner (`pharmacy:*`, solo `*`), Owner / Operator and Manager templates all
  // carry `pharmacy:manage`; cashier/pharmacist/procurement roles do not.
  if (!(await can(user, PHARMACY_PIN_ENROLMENT_CAPABILITY, undefined, { db, source: 'TRPC' })))
    return null;
  return user;
}

async function activeOrgWidePin(db: ScopedDb, organizationId: string, staffProfileId: string) {
  return db.restaurantOperatorCredential.findFirst({
    where: {
      organizationId,
      staffProfileId,
      type: 'PIN',
      deviceId: null,
      revokedAt: null,
    },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Set or reset an owner/manager PIN. Must run inside one tenant transaction.
 * Returns a refusal (instead of throwing) for a wrong current PIN so the
 * caller can COMMIT the failed-attempt counter before surfacing the error.
 */
export async function enrolPharmacyOperatorPin(
  db: ScopedDb,
  actor: PharmacyPinActor,
  input: PharmacyPinEnrolmentInput
): Promise<
  | { ok: true; credentialId: string; staffProfileId: string; targetUserId: string; reset: boolean }
  | { ok: false; code: 'CURRENT_PIN_INVALID' }
> {
  const targetUserId = input.targetUserId ?? actor.userId;
  const self = targetUserId === actor.userId;

  // Re-derive the actor's authority from the database, not the session claim.
  const actingUser = await eligibleOwnerOrManager(db, actor.organizationId, actor.userId);
  if (!actingUser)
    throw new PharmacyPinEnrolmentError('Owner or manager access is required.', 'FORBIDDEN');
  if (!self && actingUser.role !== 'ADMIN')
    throw new PharmacyPinEnrolmentError(
      "Only an owner may set another owner or manager's PIN.",
      'FORBIDDEN'
    );

  const target = self
    ? actingUser
    : await eligibleOwnerOrManager(db, actor.organizationId, targetUserId);
  if (!target)
    throw new PharmacyPinEnrolmentError(
      'A PIN can only be enrolled for an active owner or manager.',
      'TARGET_NOT_ELIGIBLE'
    );

  // Hash first: a PIN that violates policy is never persisted (and never echoed).
  let credentialHash: string;
  try {
    credentialHash = await hashOperatorCredential('PIN', input.pin);
  } catch (error) {
    if (error instanceof CredentialPolicyError)
      throw new PharmacyPinEnrolmentError(error.message, 'INVALID_PIN');
    throw error;
  }

  // Serialize concurrent enrolments for the same user.
  await db.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${JSON.stringify(['pharmacy-operator-pin', actor.organizationId, target.id])}, 0))`);

  const profiles = await db.restaurantStaffProfile.findMany({
    where: { organizationId: actor.organizationId, userId: target.id },
    select: { id: true, status: true },
    orderBy: { createdAt: 'desc' },
  });
  const activeProfile = profiles.find((profile) => profile.status === 'ACTIVE');
  if (!activeProfile && profiles.length)
    // Never silently reactivate a suspended or archived operator.
    throw new PharmacyPinEnrolmentError('This operator profile is not active.', 'PROFILE_INACTIVE');
  const profile =
    activeProfile ??
    (await db.restaurantStaffProfile.create({
      data: {
        organizationId: actor.organizationId,
        userId: target.id,
        displayName: target.name.trim() || 'Pharmacy operator',
      },
      select: { id: true, status: true },
    }));

  const existing = await activeOrgWidePin(db, actor.organizationId, profile.id);
  // A non-owner changing their own PIN must prove the current one; an owner
  // may reset (forgotten/locked PIN) on session authority alone.
  if (existing && self && actingUser.role !== 'ADMIN') {
    if (!input.currentPin)
      throw new PharmacyPinEnrolmentError(
        'Enter your current PIN to change it.',
        'CURRENT_PIN_REQUIRED'
      );
    const valid = await verifyLostDemandPin(
      db,
      { organizationId: actor.organizationId, userId: actor.userId },
      input.currentPin
    );
    if (!valid) return { ok: false, code: 'CURRENT_PIN_INVALID' };
  }

  const now = new Date();
  await db.restaurantOperatorCredential.updateMany({
    where: {
      organizationId: actor.organizationId,
      staffProfileId: profile.id,
      type: 'PIN',
      deviceId: null,
      revokedAt: null,
    },
    data: { revokedAt: now },
  });
  const credential = await db.restaurantOperatorCredential.create({
    data: {
      organizationId: actor.organizationId,
      staffProfileId: profile.id,
      deviceId: null,
      type: 'PIN',
      credentialHash,
      failedAttempts: 0,
      lockedUntil: null,
      revokedAt: null,
    },
    select: { id: true },
  });

  // Audit inside the same transaction; carries identifiers only, never the PIN or hash.
  await db.auditLog.create({
    data: {
      organizationId: actor.organizationId,
      actorId: actor.userId,
      source: 'TRPC',
      category: 'PHARMACY_OPERATOR_PIN',
      action: existing ? 'pharmacyOperatorPin.reset' : 'pharmacyOperatorPin.set',
      targetType: 'RestaurantOperatorCredential',
      targetId: credential.id,
      result: {
        targetUserId: target.id,
        staffProfileId: profile.id,
        reset: Boolean(existing),
        revokedCredentialId: existing?.id ?? null,
      },
    },
  });

  return {
    ok: true,
    credentialId: credential.id,
    staffProfileId: profile.id,
    targetUserId: target.id,
    reset: Boolean(existing),
  };
}

/** PIN status for the owner/manager roster; exposes presence only, never hashes. */
export async function listPharmacyPinStatus(db: ScopedDb, organizationId: string) {
  const users = await db.user.findMany({
    where: { organizationId },
    select: { id: true, name: true, email: true, status: true, role: true, department: true },
    orderBy: { name: 'asc' },
    take: 500,
  });
  const rows = [];
  for (const user of users) {
    if (!ACTIVE_STATUSES.has(user.status)) continue;
    if (!(await can(user, PHARMACY_PIN_ENROLMENT_CAPABILITY, undefined, { db, source: 'TRPC' })))
      continue;
    const credential = await db.restaurantOperatorCredential.findFirst({
      where: {
        organizationId,
        type: 'PIN',
        deviceId: null,
        revokedAt: null,
        staffProfile: { userId: user.id, status: 'ACTIVE' },
      },
      select: { createdAt: true, lockedUntil: true },
      orderBy: { createdAt: 'desc' },
    });
    rows.push({
      userId: user.id,
      name: user.name,
      email: user.email,
      isOwner: user.role === 'ADMIN',
      hasPin: Boolean(credential),
      pinSetAt: credential?.createdAt ?? null,
      locked: Boolean(credential?.lockedUntil && credential.lockedUntil > new Date()),
    });
  }
  return rows;
}
