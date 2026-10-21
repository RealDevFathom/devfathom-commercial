import { z } from 'zod';
import type { OrganizationStatus } from '@/generated/prisma/client';
import { ACTIVE_STATUSES } from '@/lib/auth/session-state';
import { findLoginCandidates } from '@/lib/auth/login-candidates';
import { emailLookupSchema } from '@/lib/email-address';
import { appUrl, sendEmail, templates } from '@/lib/email';
import { generateInviteToken } from '@/lib/invite-token';
import { rateLimit } from '@/lib/rate-limit';
import { isTenantLifecycleAccessible, requestHost } from '@/lib/tenancy/host';
import { isSharedHost } from '@/lib/tenancy/host-routing';
import { resolveOrganizationByHost } from '@/lib/tenancy/host';
import { withTenantDb } from '@/lib/tenancy/scoped-db';
import { ipFromHeaders } from '@/server/audit';

/**
 * D19 — anonymous "email me a reset link".
 *
 * `passwordReset.request` could not be reached: the tRPC transport answered 401
 * before the router ran, and the form swallowed the failure and showed its
 * neutral confirmation anyway, so the user was told to check an inbox that would
 * never receive anything. Verified against a running server before changing it.
 *
 * It gets its own endpoint rather than the transport allow-list because it
 * carries an EMAIL, not a token: on the shared host one address can belong to
 * several organizations, so there is no single tenant to open a transaction in.
 * Discovery therefore runs through the same narrow privileged helper the login
 * flow uses, and each eligible member gets a token minted inside their OWN
 * tenant transaction.
 *
 * The response is always the same, whatever happens.
 */
const RESET_TTL_MS = 60 * 60 * 1000;

type ResetTarget = { organizationId: string; organizationStatus: OrganizationStatus };

const bodySchema = z.object({ email: emailLookupSchema });

/** Byte-identical for every outcome, so it can never probe for accounts. */
const NEUTRAL = { ok: true };

export async function POST(request: Request) {
  const ip = ipFromHeaders(request.headers) ?? 'unknown';

  let email: string;
  try {
    email = bodySchema.parse(await request.json()).email;
  } catch {
    return Response.json(NEUTRAL);
  }

  // Throttle per IP (broad) and per address so the endpoint cannot be used to
  // flood inboxes or probe. Both hit and miss paths are throttled identically,
  // and a throttled request returns the same body as a delivered one.
  const ipGate = await rateLimit(`pwreset:ip:${ip}`, 10, 15 * 60_000);
  const emailGate = await rateLimit(`pwreset:email:${email}`, 5, 15 * 60_000);
  if (!ipGate.ok || !emailGate.ok) return Response.json(NEUTRAL);

  const host = requestHost(request);

  const targets = isSharedHost(host)
    ? (await findLoginCandidates(email)).candidates.map((candidate) => ({
        organizationId: candidate.organizationId,
        organizationStatus: candidate.organization.status,
      }))
    : await hostTarget(host);

  for (const target of targets) {
    if (!isTenantLifecycleAccessible(target.organizationStatus)) continue;
    try {
      await mintAndSend(target.organizationId, email);
    } catch (error) {
      // Never fail the request on one workspace's problem, and never let the
      // difference show in the response.
      console.error('[passwordReset] failed for', target.organizationId, error);
    }
  }

  return Response.json(NEUTRAL);
}

async function hostTarget(host: string): Promise<ResetTarget[]> {
  const organization = await resolveOrganizationByHost(host);
  if (!organization || organization.isDemo) return [];
  return [{ organizationId: organization.id, organizationStatus: organization.status }];
}

async function mintAndSend(organizationId: string, email: string): Promise<void> {
  const sent = await withTenantDb(organizationId, async (db) => {
    const user = await db.user.findFirst({
      where: { email },
      select: { id: true, name: true, email: true, status: true, password: true },
    });
    // Only mint for a real, activated account that can actually sign in.
    if (!user || !user.password || !ACTIVE_STATUSES.has(user.status)) return null;

    const { token, tokenHash } = generateInviteToken();
    await db.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + RESET_TTL_MS) },
    });
    return { token, name: user.name, email: user.email };
  });

  if (!sent) return;

  const mail = templates.passwordReset({
    name: sent.name,
    resetUrl: `${appUrl()}/reset-password/${sent.token}`,
    expiresLabel: 'in 1 hour',
  });
  await sendEmail({
    to: { email: sent.email, name: sent.name },
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
}
