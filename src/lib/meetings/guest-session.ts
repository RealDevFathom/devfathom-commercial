/**
 * Anonymous guest admission to one meeting occurrence — WHA-235 (Lane 1).
 *
 * The database-facing half of `./guest-access`, split out so that module stays
 * pure and unit-testable: everything here needs `server-only` and a scoped
 * client, and nothing here makes a decision — the decision is
 * `evaluateGuestCredential`.
 *
 * TENANT RESOLUTION IS CREDENTIAL-GATED, exactly as
 * `src/lib/auth/anonymous-tenant.ts` establishes for invites and password
 * resets. A join request arrives with no session, on a host that may name no
 * tenant, so the organization has to be DERIVED before tenant scope can be
 * entered. It is derived from the SECRET's hash — which is globally unique on
 * `MeetingOccurrenceParticipant.guestTokenHash` and therefore names exactly one
 * row and one organization — and NOT from the `publicId` in the URL.
 *
 * That ordering is the security property. `publicId` is a locator that anyone
 * given the link holds; if it resolved a tenant, holding a link would be enough
 * to learn that an occurrence exists and which organization owns it. Resolving
 * on the secret instead means a caller with only a link learns nothing, and the
 * `publicId` is then checked as a SECOND factor: the credential must belong to
 * the occurrence the caller actually asked for, so a secret for one occurrence
 * cannot be replayed against another.
 */
import 'server-only';

import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

import { evaluateGuestCredential, hashGuestSecret, type GuestRejection } from './guest-access';

/**
 * Bounds on the presented secret before it is hashed. The minted form is 24
 * characters including grouping; the range is loose enough for reasonable
 * transcription noise and tight enough that this is not a hashing oracle.
 */
const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 512;

export type GuestGrant = {
  ok: true;
  organizationId: string;
  occurrenceId: string;
  occurrenceParticipantId: string;
  publicId: string;
  displayName: string;
  /** Media room to admit the holder to. Never derivable from `publicId`. */
  providerRoomName: string;
  meetingId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  title: string;
};

export type GuestDenial = { ok: false; reason: GuestRejection };

/**
 * Admit — or refuse — a guest presenting a join link and a typed secret.
 *
 * CALLERS MUST NOT SURFACE `reason`. It is here so the server can log and
 * measure refusals; every one of them is a single indistinguishable message to
 * the caller. Telling an anonymous requester that a secret was "expired" rather
 * than "invalid" confirms that the secret, and the occurrence, were once real.
 */
export async function verifyGuestAccess(args: {
  publicId: string;
  secret: string;
  now?: Date;
}): Promise<GuestGrant | GuestDenial> {
  const now = args.now ?? new Date();

  // Bound the work before hashing, mirroring `organizationForAnonymousToken`.
  if (
    !args.secret ||
    args.secret.length < MIN_SECRET_LENGTH ||
    args.secret.length > MAX_SECRET_LENGTH ||
    !args.publicId ||
    args.publicId.length > 128
  ) {
    return { ok: false, reason: 'invalid_secret' };
  }

  const guestTokenHash = hashGuestSecret(args.secret);

  // Platform scope, because the tenant is what is being determined. As narrow
  // as that allows: the only predicate is a hash the caller must already hold,
  // and the only column out is an organization id.
  const organizationId = await withPlatformDb(async (db) => {
    const row = await db.meetingOccurrenceParticipant.findUnique({
      where: { guestTokenHash },
      select: { organizationId: true },
    });
    return row?.organizationId ?? null;
  });

  if (!organizationId) return { ok: false, reason: 'invalid_secret' };

  // Everything below runs under ordinary tenant RLS.
  return withTenantDb(organizationId, async (db): Promise<GuestGrant | GuestDenial> => {
    const participant = await db.meetingOccurrenceParticipant.findUnique({
      where: { guestTokenHash },
      select: {
        id: true,
        displayName: true,
        guestTokenHash: true,
        guestTokenExpiresAt: true,
        guestTokenRevokedAt: true,
        removedAt: true,
        occurrence: {
          select: {
            id: true,
            publicId: true,
            status: true,
            joinOpensAt: true,
            joinClosesAt: true,
            scheduledStart: true,
            scheduledEnd: true,
            providerRoomName: true,
            meetingId: true,
            titleOverride: true,
            meeting: { select: { title: true } },
          },
        },
      },
    });

    // Reachable if the row belongs to a tenant this scope cannot see, which is
    // the cross-tenant case: RLS makes it indistinguishable from absent.
    if (!participant) return { ok: false, reason: 'invalid_secret' };

    const occurrence = participant.occurrence;

    // SECOND FACTOR. The credential must belong to the occurrence the caller
    // asked for, so a valid secret for occurrence A cannot admit its holder to
    // occurrence B by swapping the link.
    if (occurrence.publicId !== args.publicId) {
      return { ok: false, reason: 'unknown_occurrence' };
    }

    const verdict = evaluateGuestCredential({
      credential: participant,
      occurrence,
      presentedSecret: args.secret,
      now,
    });
    if (!verdict.ok) return verdict;

    return {
      ok: true,
      organizationId,
      occurrenceId: occurrence.id,
      occurrenceParticipantId: participant.id,
      publicId: occurrence.publicId,
      displayName: participant.displayName,
      providerRoomName: occurrence.providerRoomName,
      meetingId: occurrence.meetingId,
      scheduledStart: occurrence.scheduledStart,
      scheduledEnd: occurrence.scheduledEnd,
      title: occurrence.titleOverride ?? occurrence.meeting.title,
    };
  });
}
