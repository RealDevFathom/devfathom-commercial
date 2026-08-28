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

/**
 * A UUIDv4, which is what `MeetingOccurrence.publicId` is defaulted to in the
 * database (`gen_random_uuid()::text`). Shape-checking here is the join flow's
 * equivalent of the length bound above: a malformed id costs a regex, not a
 * round trip. MEET-004 step 2.
 */
const MEETING_PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the tenant for an anonymous meeting-join request.
 *
 * `MeetingOccurrence.publicId` is the THIRD anonymous tenant-resolution key in
 * this codebase, alongside the two token hashes above — the shared public join
 * URL (`/meet/<publicId>`) carries no tenant context by product design, so the
 * identifier must name exactly one organization before tenant scope is entered.
 * That is why the column is globally, not per-tenant, unique. MEET-004 D2/D4.
 *
 * It lives here, next to `organizationForAnonymousToken`, because it must
 * reproduce every property that made that resolver acceptable, and colocating
 * them is what keeps the two from drifting: platform scope only because the
 * tenant is what is being determined, a single predicate the caller must
 * already hold, only an organization id returned, input bounded before the
 * query, and null for anything unknown.
 *
 * IT IS A LOCATOR, NOT AUTHORIZATION (MEET-004 D3). A successful resolution
 * grants nothing: it names a tenant. Admission is a separate act, and lives in
 * `src/lib/meetings/admission.ts`.
 */
export async function organizationForMeetingPublicId(
  publicId: string | null | undefined
): Promise<string | null> {
  if (!publicId || !MEETING_PUBLIC_ID.test(publicId)) return null;

  return withPlatformDb(async (db) => {
    const occurrence = await db.meetingOccurrence.findUnique({
      where: { publicId },
      select: { organizationId: true },
    });
    return occurrence?.organizationId ?? null;
  });
}
