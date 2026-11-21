import 'server-only';

import { createHmac } from 'node:crypto';
import type { PlatformJob } from '@/generated/prisma/client';
import { PASSWORD_RESET_TTL_MS } from '@/lib/auth/admin-password-reset';
import { findLoginCandidates } from '@/lib/auth/login-candidates';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { appUrl, sendEmail, templates } from '@/lib/email';
import { hashInviteToken } from '@/lib/invite-token';
import { isTenantLifecycleAccessible, resolveOrganizationByHost } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

/** A shared host has no tenant to own an outbox row until discovery runs. */
export async function enqueuePasswordReset(
  email: string,
  target: { host: string } | { organizationId: string }
) {
  await withPlatformDb((db) =>
    db.platformJob.create({
      data: {
        type: 'PASSWORD_RESET_REQUEST_V1',
        organizationId: 'organizationId' in target ? target.organizationId : null,
        payload: 'host' in target ? { email, host: target.host } : { email },
      },
      select: { id: true },
    })
  );
}

async function deliverTenantPasswordReset(
  organizationId: string,
  email: string,
  requestId: string
) {
  const target = await withTenantDb(organizationId, async (db) => {
    // Use the same member lock as consumption and credential changes. A concurrent
    // email change can invalidate this lookup while it waits for the lock.
    const [member] = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE "organizationId" = ${organizationId} AND email = ${email} FOR UPDATE
    `;
    if (!member) return null;
    const user = await db.user.findUniqueOrThrow({
      where: { id: member.id },
      select: {
        name: true,
        email: true,
        password: true,
        status: true,
        organization: { select: { status: true, isDemo: true } },
      },
    });
    if (
      !user.password ||
      !ACTIVE_STATUSES.has(user.status) ||
      user.organization.isDemo ||
      !isTenantLifecycleAccessible(user.organization.status)
    )
      return null;

    // A worker can retry after an ambiguous mail-provider response. Re-send the
    // same link, preserving its first expiry and any subsequent consumption.
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error('AUTH_SECRET is required for password recovery.');
    const id = hashInviteToken(
      JSON.stringify(['password-reset', requestId, organizationId, member.id])
    );
    const token = createHmac('sha256', secret)
      .update('password-reset:' + id)
      .digest('base64url');
    const tokenHash = hashInviteToken(token);
    const record = await db.passwordResetToken.upsert({
      where: { id },
      create: {
        id,
        userId: member.id,
        tokenHash,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
      update: {},
      select: { usedAt: true, expiresAt: true, tokenHash: true },
    });
    if (record.usedAt || record.expiresAt.getTime() <= Date.now() || record.tokenHash !== tokenHash)
      return null;
    // The member lock serializes issuers and consumers. A superseded job
    // returned above, so retrying it cannot retire the current link.
    await db.passwordResetToken.updateMany({
      where: { userId: member.id, usedAt: null, id: { not: id } },
      data: { usedAt: new Date() },
    });
    return { name: user.name, email: user.email, token };
  });

  if (!target) return;
  const mail = templates.passwordReset({
    name: target.name,
    resetUrl: `${appUrl()}/reset-password/${target.token}`,
    expiresLabel: 'in 1 hour',
  });
  await sendEmail({ to: { email: target.email, name: target.name }, ...mail });
}

export async function runPasswordResetJob(
  job: Pick<PlatformJob, 'id' | 'organizationId' | 'payload'>
) {
  const data = job.payload;
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.email !== 'string') {
    throw new Error('Invalid password reset job.');
  }
  const { email, host } = data;
  let targets: string[];
  if (job.organizationId) {
    targets = [job.organizationId];
  } else if (typeof host !== 'string') {
    throw new Error('Missing password reset host.');
  } else if (isSharedHost(host)) {
    targets = (await findLoginCandidates(email)).candidates.map(
      (candidate) => candidate.organizationId
    );
  } else {
    const target = await resolveOrganizationByHost(host);
    targets = target ? [target.id] : [];
  }
  let failed = false;
  for (const organizationId of targets) {
    try {
      await deliverTenantPasswordReset(organizationId, email, job.id);
    } catch {
      failed = true;
    }
  }
  if (failed) throw new Error('Password reset delivery failed.');
  return {};
}
