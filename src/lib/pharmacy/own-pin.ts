import 'server-only';

import type { AuthzDb } from '@/lib/authz';
import { can, subjectFromSession } from '@/lib/abac';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import type { ApprovalAuthenticatorParty } from '@/lib/approval-authenticator';
import { ensureAdministratorStaffProfile } from '@/lib/restaurant/administrator-staff-profile';
import {
  issueOperatorCredential,
  revokeOperatorCredential,
  rotateOperatorCredential,
} from '@/lib/restaurant/credential-lifecycle';
import { isLockedOut } from '@/lib/restaurant/operator-credentials';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * DEV-931 — a person's own approval PIN in the pharmacy.
 *
 * There is one PIN store: the operator credential (`restaurant_operator_credentials`) on the
 * staff profile linked to the person's web login, device-independent, type PIN. It is the
 * credential every pharmacy approval already verifies (`verifyOwnerExportPin`, the counter,
 * refund, witness and purchase approvals), so this module only creates, changes and resets
 * it through the existing lifecycle (`credential-lifecycle.ts`), which hashes with bcrypt,
 * enforces the 4 to 8 digit floor and keeps the shared lockout counters. Nothing here
 * returns, logs or stores a PIN.
 */

export type OwnPinState = {
  /** SET: an active PIN. NOT_SET: none yet. RESET: a manager reset it; set a new one. */
  state: 'SET' | 'NOT_SET' | 'RESET';
  locked: boolean;
  lockedUntil: Date | null;
};

const activePin = (organizationId: string, userId: string) =>
  ({
    organizationId,
    type: 'PIN',
    deviceId: null,
    revokedAt: null,
    staffProfile: { organizationId, userId, status: 'ACTIVE' },
  }) as const;

export async function readOwnPinState(
  db: ScopedDb,
  organizationId: string,
  userId: string,
  now: Date = new Date()
): Promise<OwnPinState> {
  const [active, revoked] = await Promise.all([
    db.restaurantOperatorCredential.findFirst({
      where: activePin(organizationId, userId),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { failedAttempts: true, lockedUntil: true },
    }),
    db.restaurantOperatorCredential.findFirst({
      where: {
        organizationId,
        type: 'PIN',
        deviceId: null,
        revokedAt: { not: null },
        staffProfile: { organizationId, userId },
      },
      select: { id: true },
    }),
  ]);
  if (!active) return { state: revoked ? 'RESET' : 'NOT_SET', locked: false, lockedUntil: null };
  const locked = isLockedOut(active, now);
  return { state: 'SET', locked, lockedUntil: locked ? active.lockedUntil : null };
}

export class OwnPinError extends Error {
  constructor(
    message: string,
    readonly reason: 'PROFILE_INACTIVE' | 'NOT_FOUND'
  ) {
    super(message);
    this.name = 'OwnPinError';
  }
}

/**
 * Create or change the signed-in person's own PIN. Run inside one transaction: the person's
 * user row is locked first, so two simultaneous saves cannot both create a credential.
 * Creating gives a person without a staff profile one (no role, no branch grant); a
 * suspended or archived profile is refused. Changing rotates the live credential in place,
 * which also clears its strikes.
 */
export async function saveOwnPin(
  db: ScopedDb,
  input: { organizationId: string; userId: string; pin: string }
): Promise<{ action: 'created' | 'changed'; credentialId: string; staffProfileId: string }> {
  const { organizationId, userId } = input;
  const user = await db.$queryRaw<Array<{ name: string | null; email: string | null }>>`
    SELECT name, email FROM users WHERE id=${userId} AND "organizationId"=${organizationId} FOR UPDATE`;
  if (!user[0]) throw new OwnPinError('Your account was not found.', 'NOT_FOUND');
  const current = await db.restaurantOperatorCredential.findFirst({
    where: activePin(organizationId, userId),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, staffProfileId: true },
  });
  if (current) {
    const rotated = await rotateOperatorCredential(db, {
      credentialId: current.id,
      secret: input.pin,
    });
    return { action: 'changed', credentialId: rotated.id, staffProfileId: current.staffProfileId };
  }
  const activeProfile = await db.restaurantStaffProfile.findFirst({
    where: { organizationId, userId, status: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  const profile = activeProfile
    ? { staffProfileId: activeProfile.id }
    : await ensureAdministratorStaffProfile(db, {
        organizationId,
        userId,
        displayName: user[0].name,
        email: user[0].email,
      });
  const live = activeProfile
    ? { status: 'ACTIVE' }
    : await db.restaurantStaffProfile.findFirst({
        where: { id: profile.staffProfileId, organizationId, userId },
        select: { status: true },
      });
  if (live?.status !== 'ACTIVE')
    throw new OwnPinError(
      'Your staff profile is not active. Ask the owner or a manager to restore it.',
      'PROFILE_INACTIVE'
    );
  const issued = await issueOperatorCredential(db, {
    staffProfileId: profile.staffProfileId,
    type: 'PIN',
    secret: input.pin,
  });
  return { action: 'created', credentialId: issued.id, staffProfileId: profile.staffProfileId };
}

/**
 * Reset (revoke) another person's PIN. The person then creates a new one themselves; the
 * resetter never sets or sees it. Returns how many live PINs were revoked.
 */
export async function resetMemberPin(
  db: ScopedDb,
  input: { organizationId: string; userId: string; now?: Date }
): Promise<number> {
  const { organizationId, userId } = input;
  await db.$queryRaw`SELECT id FROM users WHERE id=${userId} AND "organizationId"=${organizationId} FOR UPDATE`;
  const live = await db.restaurantOperatorCredential.findMany({
    where: {
      organizationId,
      type: 'PIN',
      deviceId: null,
      revokedAt: null,
      staffProfile: { organizationId, userId },
    },
    select: { id: true },
  });
  const now = input.now ?? new Date();
  for (const credential of live)
    await revokeOperatorCredential(db, { credentialId: credential.id, now });
  return live.length;
}

/** The member data `pinResetDenial` reads, loaded live (see `approvalAuthenticatorPartySelect`). */
export type PinResetParty = ApprovalAuthenticatorParty & { department?: string | null };

/** True for the owner, an administrator, or a member granted the staff-management right. */
export async function managesStaffPins(db: ScopedDb, actor: PinResetParty): Promise<boolean> {
  if (actor.status !== 'ACTIVE') return false;
  if (hasAllCapabilityAccess(actor) || actor.role === 'ADMIN') return true;
  return can(subjectFromSession(actor), 'staff:manage', undefined, {
    db: db as unknown as AuthzDb,
    source: 'TRPC',
  });
}

/**
 * Who may reset whose PIN:
 *   - nobody resets their own here (they change it on "Your PIN" with their password);
 *   - the owner (the live all-capability identity) may reset anyone else;
 *   - an administrator, or a member granted `staff:manage`, may reset only a member below
 *     them: never another administrator or the owner;
 *   - nobody else may reset anyone.
 * Returns a refusal, or null when the reset may proceed.
 */
export async function pinResetDenial(
  db: ScopedDb,
  actor: PinResetParty,
  target: PinResetParty
): Promise<string | null> {
  if (actor.id === target.id) return 'Change your own PIN under Your PIN.';
  if (!(await managesStaffPins(db, actor)))
    return 'Only the owner or a manager who manages staff can reset a PIN.';
  if (hasAllCapabilityAccess(actor)) return null;
  if (hasAllCapabilityAccess(target) || target.role === 'ADMIN')
    return "Only the owner can reset this person's PIN.";
  return null;
}
