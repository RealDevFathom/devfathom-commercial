import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import type { Prisma } from '@/generated/prisma/client';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';

/**
 * The one administrative password-reset policy (AUTH-01, DEV-838).
 *
 * Every path an administrator uses to reset another member's password — the
 * team page, the organization admin page and the assistant — writes these
 * fields, so a reset always:
 *   - bumps `tokenVersion`, which makes every already-issued JWT fail its next
 *     revalidation (src/lib/auth.ts), and
 *   - clears `passwordChangedAt` and sets `mustChangePassword`, so the next
 *     sign-in is forced through a password rotation.
 *
 * `passwordHash` is the bcrypt hash of the new credential. The by-hand admin
 * screens pass the temporary password the administrator typed. The assistant
 * never chooses one: it passes `unusablePasswordHash()`, which retires the old
 * (possibly compromised) password, and emails the member a private, single-use
 * reset link so only the member ever chooses (or sees) the replacement.
 */
export function adminPasswordResetData(passwordHash: string): Prisma.UserUpdateInput {
  return {
    password: passwordHash,
    passwordChangedAt: null,
    mustChangePassword: true,
    tokenVersion: { increment: 1 },
  };
}

/** How long an emailed password-reset link stays usable (mirrors passwordReset.request). */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * A bcrypt hash of 256 random bits that is never stored, returned or logged in
 * plaintext. Installing it invalidates the member's previous password without
 * creating a credential anyone knows: sign-in resumes only through the emailed
 * single-use reset link (or the public forgot-password flow).
 */
export async function unusablePasswordHash(): Promise<string> {
  return hash(randomBytes(32).toString('base64url'), 12);
}

const ROLE_RANK: Record<string, number> = { EMPLOYEE: 1, HR: 2, ADMIN: 3 };

type ResetParty = Parameters<typeof hasAllCapabilityAccess>[0] & { role: string };

const RESET_PARTY_SELECT = {
  role: true,
  status: true,
  organizationRole: { select: { key: true, isSystem: true, permissions: true } },
  permissionOverrides: {
    where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { capability: true, effect: true },
  },
};

/**
 * Role-hierarchy guard shared by every administrative password reset (team page,
 * organization admin page, assistant). The organization owner (the live
 * all-capability identity, see `hasAllCapabilityAccess`; an explicit DENY removes
 * it) sits above every admin. Rules, in order:
 *   - nobody resets themselves here (use change password: it checks the current one);
 *   - nobody resets the owner (the owner uses the self-service flow);
 *   - the owner may reset anyone else, so a solo owner can always recover staff;
 *   - everyone else may reset only a strictly lower role: an admin resets staff and
 *     HR but not another admin.
 * Returns a denial message, or null when the reset may proceed. An unknown role
 * ranks above every known one, so it fails closed.
 */
export function passwordResetDenialFor(
  actor: { id: string } & ResetParty,
  target: { id: string } & ResetParty
): string | null {
  if (actor.id === target.id) return 'Use change password to update your own password.';
  if (hasAllCapabilityAccess(target)) {
    return 'The organization owner password can only be changed by the owner.';
  }
  if (hasAllCapabilityAccess(actor)) return null;
  const actorRank = ROLE_RANK[actor.role] ?? 0;
  const targetRank = ROLE_RANK[target.role] ?? Number.POSITIVE_INFINITY;
  return targetRank >= actorRank
    ? 'You can only reset the password of a member with a lower role.'
    : null;
}

/** Loads both members live (never trusting a session role) and applies the guard. */
export async function passwordResetDenial(
  db: ScopedDb,
  input: { actorId: string; targetId: string }
): Promise<string | null> {
  const [actor, target] = await Promise.all([
    db.user.findUnique({ where: { id: input.actorId }, select: RESET_PARTY_SELECT }),
    db.user.findUnique({ where: { id: input.targetId }, select: RESET_PARTY_SELECT }),
  ]);
  if (!actor || !target) return 'Member not found.';
  return passwordResetDenialFor(
    { ...actor, id: input.actorId },
    { ...target, id: input.targetId }
  );
}
