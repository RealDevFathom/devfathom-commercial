import 'server-only';

import { hashInviteToken } from '@/lib/invite-token';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

/**
 * D19 — resolve the tenant for an anonymous, token-bearing request.
 *
 * The invite and password-reset flows have no session and, on the shared host,
 * no host organization either. Both `Invitation.tokenHash` and
 * `PasswordResetToken.tokenHash` are GLOBALLY unique, so the token alone
 * identifies exactly one row and therefore exactly one organization.
 *
 * The lookup runs in the platform scope for the same reason `findLoginCandidates`
 * does — the tenant is not yet known — and is equally narrow: the only predicate
 * is the SHA-256 hash of a token the caller must already hold, and the only field
 * returned is the organization id. Everything after this runs in
 * `withTenantDb(organizationId, …)`.
 *
 * A caller who does not hold a valid token learns nothing: the answer is null,
 * and the procedures behind it return their own uniform "invalid or expired".
 */
export async function organizationForAnonymousToken(
  token: string | null | undefined
): Promise<string | null> {
  if (!token || token.length < 8 || token.length > 512) return null;
  const tokenHash = hashInviteToken(token);

  return withPlatformDb(async (db) => {
    const invitation = await db.invitation.findUnique({
      where: { tokenHash },
      select: { organizationId: true },
    });
    if (invitation) return invitation.organizationId;

    const reset = await db.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { organizationId: true },
    });
    return reset?.organizationId ?? null;
  });
}
