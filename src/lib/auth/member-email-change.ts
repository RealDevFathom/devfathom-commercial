import type { Prisma } from '@/generated/prisma/client';
import { hasAllCapabilityAccess } from '@/lib/abac/owner-access';
import { appUrl, sendEmail, templates } from '@/lib/email';
import { generateInviteToken } from '@/lib/invite-token';
import { INVITE_TTL_MS } from '@/lib/member-invitation';
import type { ScopedDb } from '@/lib/tenancy/scoped-db';
import { RESET_PARTY_SELECT, ROLE_RANK, type ResetParty } from './admin-password-reset';

/**
 * DEV-974: the one policy for changing a member's sign-in email.
 *
 * The email is the sign-in identity and the address password resets go to, so
 * whoever can change it can take the account. Every path that changes it (team
 * page, SCIM) applies these rules:
 *   - a member changing their own email proves it is them with their current
 *     password (checked by the caller); the old address is told;
 *   - nobody else changes the email of an owner-level member;
 *   - the owner (the live all-capability identity) may change anyone else's;
 *   - everyone else may change only a strictly lower base role, so an
 *     administrator corrects staff and HR but never another administrator.
 * When someone other than the member makes the change, the account must be
 * confirmed from the NEW address before it can sign in or receive a reset: it
 * returns to the invited state (no password, every session revoked) and the
 * existing single-use invitation link goes to the new address. Pending reset
 * links are cancelled on every change, and both addresses are notified.
 */

type Rule = { capability: string; effect: string };

/**
 * Owner-level for a TARGET, failing closed: the system owner role or any `*` grant,
 * whatever the member's status or DENY rules. (`hasAllCapabilityAccess` is the live
 * test for an ACTOR; a deactivated or restricted owner is still not someone an
 * administrator may re-address.)
 */
export function holdsOwnerLevelAccess(member: {
  organizationRole?: { key?: string; isSystem?: boolean; permissions: readonly Rule[] } | null;
  permissionOverrides: readonly Rule[];
}): boolean {
  const role = member.organizationRole;
  if (role?.isSystem && role.key === 'owner') return true;
  return [...member.permissionOverrides, ...(role?.permissions ?? [])].some(
    (rule) => rule.capability === '*' && rule.effect === 'ALLOW'
  );
}

/** Returns a refusal, or null when `actor` may change `target`'s email. Self is the
 * caller's job (it must check the current password). */
export function emailChangeDenialFor(
  actor: { id: string } & ResetParty,
  target: { id: string } & ResetParty
): string | null {
  if (actor.id === target.id) return null;
  if (holdsOwnerLevelAccess(target)) return "Only the owner can change the owner's email.";
  if (hasAllCapabilityAccess(actor)) return null;
  const actorRank = ROLE_RANK[actor.role] ?? 0;
  const targetRank = ROLE_RANK[target.role] ?? Number.POSITIVE_INFINITY;
  return targetRank >= actorRank
    ? 'You can only change the email of a member with a lower role.'
    : null;
}

/** Loads both members live (never trusting a session role) and applies the rule. */
export async function emailChangeDenial(
  db: Pick<ScopedDb, 'user'> | Prisma.TransactionClient,
  input: { actorId: string; targetId: string }
): Promise<string | null> {
  const [actor, target] = await Promise.all([
    db.user.findUnique({ where: { id: input.actorId }, select: RESET_PARTY_SELECT }),
    db.user.findUnique({ where: { id: input.targetId }, select: RESET_PARTY_SELECT }),
  ]);
  if (!actor || !target) return 'Member not found.';
  return emailChangeDenialFor({ ...actor, id: input.actorId }, { ...target, id: input.targetId });
}

/**
 * SCIM: any administrator can mint a SCIM token, so a directory request is treated
 * as administrator-level. It may change the email of a member below an
 * administrator, never of an administrator or an owner-level member.
 */
export async function directoryEmailChangeDenial(
  db: Pick<ScopedDb, 'user'> | Prisma.TransactionClient,
  targetId: string
): Promise<string | null> {
  const target = await db.user.findUnique({ where: { id: targetId }, select: RESET_PARTY_SELECT });
  if (!target) return 'Member not found.';
  if (holdsOwnerLevelAccess(target) || (ROLE_RANK[target.role] ?? Infinity) >= ROLE_RANK.ADMIN!) {
    return 'The email of an owner or administrator can only be changed in DevFathom.';
  }
  return null;
}

/** Statuses whose holder could sign in; an email change by someone else sends them
 * back to INVITED until the new address confirms. INACTIVE stays INACTIVE. */
const CONFIRMABLE_STATUSES = new Set(['ACTIVE', 'ON_LEAVE', 'INVITED']);

export type MemberEmailChange = {
  userId: string;
  name: string;
  from: string;
  to: string;
  /** True when the member is changing their own email (already re-authenticated). */
  selfChange: boolean;
  /** Present when the new address must confirm before sign-in. */
  confirmationToken: string | null;
};

/**
 * Writes the sign-in side effects of an email change. Run it in the same
 * transaction as the email write, AFTER the email is updated. Returns the notice
 * details to hand to `sendMemberEmailChangeNotices` once the transaction commits.
 */
export async function applyMemberEmailChangeEffects(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    name: string;
    from: string;
    to: string;
    status: string;
    selfChange: boolean;
    changedById: string | null;
    now?: Date;
  }
): Promise<MemberEmailChange> {
  const now = input.now ?? new Date();
  // A reset link minted before the change must never complete after it.
  await tx.passwordResetToken.updateMany({
    where: { userId: input.userId, usedAt: null },
    data: { usedAt: now },
  });
  let confirmationToken: string | null = null;
  if (!input.selfChange) {
    const confirm = CONFIRMABLE_STATUSES.has(input.status);
    await tx.user.update({
      where: { id: input.userId },
      data: {
        password: null,
        passwordChangedAt: null,
        mustChangePassword: false,
        tokenVersion: { increment: 1 },
        ...(confirm ? { status: 'INVITED' } : {}),
      },
    });
    if (confirm) {
      const { token, tokenHash } = generateInviteToken();
      const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
      await tx.invitation.upsert({
        where: { userId: input.userId },
        create: {
          userId: input.userId,
          email: input.to,
          tokenHash,
          invitedById: input.changedById,
          expiresAt,
        },
        update: {
          email: input.to,
          tokenHash,
          expiresAt,
          acceptedAt: null,
          invitedById: input.changedById,
        },
      });
      confirmationToken = token;
    }
  }
  return {
    userId: input.userId,
    name: input.name,
    from: input.from,
    to: input.to,
    selfChange: input.selfChange,
    confirmationToken,
  };
}

/** Best-effort: tells the old address, and tells (or asks to confirm) the new one. */
export async function sendMemberEmailChangeNotices(
  change: MemberEmailChange,
  byName: string | null
): Promise<void> {
  const confirmUrl = change.confirmationToken
    ? `${appUrl()}/invite/${change.confirmationToken}`
    : undefined;
  const mails = [
    {
      to: change.from,
      mail: templates.signInEmailChanged({
        name: change.name,
        from: change.from,
        to: change.to,
        byName: change.selfChange ? undefined : (byName ?? undefined),
        audience: 'old',
      }),
    },
    {
      to: change.to,
      mail: templates.signInEmailChanged({
        name: change.name,
        from: change.from,
        to: change.to,
        byName: change.selfChange ? undefined : (byName ?? undefined),
        audience: 'new',
        confirmUrl,
        expiresLabel: confirmUrl ? 'in 7 days' : undefined,
      }),
    },
  ];
  await Promise.all(
    mails.map(({ to, mail }) =>
      sendEmail({
        to: { email: to, name: change.name },
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      }).catch((error) =>
        console.error('[email-change] notice failed for user', change.userId, error)
      )
    )
  );
}
