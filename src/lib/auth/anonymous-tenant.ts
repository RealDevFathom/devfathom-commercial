import 'server-only';

import { hashInviteToken } from '@/lib/invite-token';
import { withPlatformDb } from '@/lib/tenancy/scoped-db';

/**
 * Resolve the tenant for an anonymous, token-bearing request.
 *
 * The invite and password-reset flows have no session, and the host they arrive
 * on may be a shared one that names no tenant. Both `Invitation.tokenHash` and
 * `PasswordResetToken.tokenHash` are GLOBALLY unique, so the token alone
 * identifies exactly one row and therefore exactly one organization.
 *
 * The lookup runs in the platform scope because the tenant is precisely what is
 * being determined. It is deliberately as narrow as that allows: the only
 * predicate is the SHA-256 hash of a token the caller must already hold, and the
 * only column returned is an organization id. Everything downstream of this runs
 * inside `withTenantDb(organizationId, …)` under normal tenant RLS.
 *
 * A caller without a valid token learns nothing — the answer is null, and the
 * transport then answers from the fallback router with exactly the same generic
 * response a real-but-expired token would produce.
 */
export async function organizationForAnonymousToken(
  token: string | null | undefined
): Promise<string | null> {
  // Bound the work before hashing. Real tokens are 43 base64url characters
  // (32 random bytes); anything far outside that is not worth a round trip.
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
