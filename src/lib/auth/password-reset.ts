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

// Only status crosses this boundary; neither token nor link reaches the model.
export async function emailPasswordReset(
  db: PrismaClient,
  user: { id: string; organizationId: string; name: string; email: string }
): Promise<boolean> {
  const { token, tokenHash } = generateInviteToken();
  await db.passwordResetToken.create({
    data: {
      organizationId: user.organizationId,
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  const mail = templates.passwordReset({
    name: user.name,
    resetUrl: `${appUrl()}/reset-password/${token}`,
    expiresLabel: 'in 1 hour',
  });
  try {
    await sendEmail({ to: { email: user.email, name: user.name }, ...mail });
    return true;
  } catch {
    // Provider errors may contain the payload, including the recovery link.
    return false;
  }
}

export async function initiateAdminPasswordReset(
  db: PrismaClient,
  organizationId: string,
  userId: string
) {
  return db.$transaction(async (tx) => {
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
    const emailSent = await emailPasswordReset(tx as PrismaClient, user);
    return { user, emailSent };
  });
}
