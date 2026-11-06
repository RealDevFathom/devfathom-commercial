import 'server-only';

import type { PrismaClient } from '@/generated/prisma/client';
import { appUrl, templates, sendEmail } from '@/lib/email';
import { generateInviteToken } from '@/lib/invite-token';

export const RESET_TTL_MS = 60 * 60 * 1000;

// Call after locking/updating the user, in the same tenant transaction. The
// user row serializes initiation and completion, including competing links.
export async function revokePasswordResetCredentials(
  tx: PrismaClient,
  organizationId: string,
  userId: string
) {
  const where = { organizationId, userId };
  await tx.invitation.updateMany({
    where: { ...where, acceptedAt: null },
    data: { expiresAt: new Date(0) },
  });
  await tx.apiToken.deleteMany({ where });
  await tx.tenantSsoTicket.deleteMany({ where });
  await tx.passwordResetToken.updateMany({
    where: { ...where, usedAt: null },
    data: { usedAt: new Date() },
  });
}

// A manual (admin-set) password cannot sign in an INVITED member, and the reset
// revokes their pending invitation. Refuse it before any credential changes so
// the member keeps a working onboarding path (re-send the invitation instead).
export const PENDING_INVITATION_RESET_MESSAGE =
  'This member has not accepted their invitation yet. Re-send the invitation instead of setting a password.';

type ResetRecipient = { id: string; organizationId: string; name: string; email: string };

async function issuePasswordResetToken(db: PrismaClient, user: ResetRecipient): Promise<string> {
  const { token, tokenHash } = generateInviteToken();
  await db.passwordResetToken.create({
    data: {
      organizationId: user.organizationId,
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  return token;
}

// Send only after the token is durable: the link must never point at a row that
// can still roll back, and network I/O must not hold a transaction open.
async function sendPasswordResetEmail(
  user: ResetRecipient,
  token: string,
  source: string
): Promise<boolean> {
  const mail = templates.passwordReset({
    name: user.name,
    resetUrl: `${appUrl()}/reset-password/${token}`,
    expiresLabel: 'in 1 hour',
  });
  try {
    await sendEmail({ to: { email: user.email, name: user.name }, ...mail });
    return true;
  } catch (err) {
    // Provider errors may contain the payload, including the recovery link, so
    // log only the error class and the user id — never the error itself.
    console.error(`[${source}] password reset email failed`, {
      userId: user.id,
      error: err instanceof Error ? err.name : typeof err,
    });
    return false;
  }
}

// Only status crosses this boundary; neither token nor link reaches the model.
export async function emailPasswordReset(db: PrismaClient, user: ResetRecipient): Promise<boolean> {
  const token = await issuePasswordResetToken(db, user);
  return sendPasswordResetEmail(user, token, 'passwordReset.request');
}

export async function initiateAdminPasswordReset(
  db: PrismaClient,
  organizationId: string,
  userId: string
) {
  // Commit the version bump, credential revocation and new token first; only
  // then send the email, outside the transaction.
  const issued = await db.$transaction(async (tx) => {
    const user = await tx.user.findFirst({
      where: { id: userId, organizationId, organization: { isDemo: false } },
      select: { id: true, organizationId: true, name: true, email: true },
    });
    if (!user) return null;
    await tx.user.update({
      where: { id: user.id, organizationId },
      data: { tokenVersion: { increment: 1 } },
    });
    await revokePasswordResetCredentials(tx as PrismaClient, organizationId, user.id);
    const token = await issuePasswordResetToken(tx as PrismaClient, user);
    return { user, token };
  });
  if (!issued) return null;
  const emailSent = await sendPasswordResetEmail(issued.user, issued.token, 'admin.passwordReset');
  return { user: issued.user, emailSent };
}
