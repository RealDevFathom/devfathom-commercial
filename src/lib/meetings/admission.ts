import 'server-only';

import { createHash } from 'node:crypto';
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import { canAccessMeeting } from '@/lib/authz';
import type { MeetingParticipantRole } from '@/generated/prisma/client';
import type { MeetingAdmission } from './admission-contract';
import { createMeetingProviderIdentity } from './provider-identity';
import { organizationForMeetingPublicId } from '@/lib/auth/anonymous-tenant';
import {
  isTenantLifecycleAccessible,
  resolveExplicitOrganizationByHost,
  resolveOrganizationById,
} from '@/lib/tenancy/host';
import { classifyHost } from '@/lib/tenancy/host-routing';
import { withTenantDb } from '@/lib/tenancy/scoped-db';

/**
 * Sized for a join plus a reconnect, NOT for the meeting's duration
 * (MEET-002 §3, MEET-001 T5). Removal from a meeting is mitigated by this
 * number plus refusal to reissue — there is no token revocation at the
 * provider — so lengthening it directly lengthens the window in which a
 * removed participant can still re-enter.
 */
const TOKEN_TTL_SECONDS = 10 * 60;

export const GENERIC_ADMISSION_ERROR = 'This meeting is unavailable or the access code is invalid.';

export type { MeetingAdmission } from './admission-contract';

/**
 * Every refusal is the same `refused` — the caller renders one generic message
 * regardless of cause, so an unknown public id, a wrong host, a suspended
 * workspace, an expired credential and a closed join window are
 * indistinguishable (MEET-001 T5, MEET-004 step 7).
 *
 * `waiting` is NOT a refusal and is only ever reached AFTER the caller has
 * proven a credential — a matching guest token hash on this occurrence, or a
 * session that passes `canAccessMeeting`. It therefore discloses nothing a
 * refusal would have hidden: it tells someone already known to belong to the
 * meeting that a host has not admitted them yet.
 */
export type AdmissionOutcome =
  | { status: 'admitted'; admission: MeetingAdmission }
  | { status: 'waiting' }
  | { status: 'refused' };

const REFUSED = { status: 'refused' } as const;

/** In-tenant sentinel for "credential proven, host has not admitted yet". */
const WAITING = 'waiting' as const;

export function hashGuestToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isJoinableOccurrence(input: {
  now: Date;
  joinOpensAt: Date;
  joinClosesAt: Date;
  status: string;
  cancelledAt: Date | null;
}): boolean {
  return (
    !input.cancelledAt &&
    !['DRAFT', 'ENDING', 'ENDED', 'CANCELLED'].includes(input.status) &&
    input.now >= input.joinOpensAt &&
    input.now <= input.joinClosesAt
  );
}

/**
 * MEET-004 step 5 (D7). The join URL is served on both the shared host, which
 * names no tenant, and on tenant hosts, which do.
 *
 * On a tenant host the host's organization must equal the one the public id
 * resolved to. A mismatch is refused exactly like an unknown id — never a
 * redirect, which would confirm to a visitor on company B's host that the
 * occurrence belongs to some other named organization.
 *
 * The STRICT resolver is used deliberately. The permissive
 * `resolveOrganizationByHost` falls back to `DEFAULT_ORGANIZATION_ID` for any
 * configured default host, which would make this cross-check pass spuriously
 * rather than fail closed.
 *
 * Consequence worth stating: bare `localhost` classifies as a tenant host that
 * names no tenant, so the strict resolver returns null and the join is refused.
 * Local verification of this route uses `<slug>.localhost`, which resolves by
 * slug, or a shared host label.
 */
async function hostPermits(host: string | null | undefined, organizationId: string) {
  const classified = classifyHost(host);
  if (classified.kind === 'shared') return true;
  if (classified.kind !== 'tenant') return false;
  const organization = await resolveExplicitOrganizationByHost(host);
  return organization?.id === organizationId;
}

function liveKitConfiguration() {
  const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!serverUrl || !apiKey || !apiSecret) throw new Error('Meeting media is not configured.');
  return { serverUrl, apiKey, apiSecret };
}

/**
 * MEET-004 step 7 — the only step that grants anything.
 *
 * The pipeline before it is fixed and ordered: resolve the tenant from the
 * public id alone (step 3), confirm that tenant may serve traffic (step 4), and
 * cross-check the host (step 5). Only then is the occurrence loaded, in TENANT
 * scope under ordinary RLS (step 6) — never in platform scope, which is used
 * for nothing but determining which tenant this is.
 */
export async function admitToMeeting(input: {
  publicId: string;
  host?: string | null;
  guestToken?: string | null;
  sessionUser?: { id: string; organizationId: string; role?: string | null } | null;
  now?: Date;
}): Promise<AdmissionOutcome> {
  const organizationId = await organizationForMeetingPublicId(input.publicId);
  if (!organizationId) return REFUSED;

  // Step 4. A tenant reached anonymously must still be one that may serve
  // traffic; a workspace that may not is treated as unroutable rather than as a
  // distinct error, so its status stays unobservable without a session.
  const organization = await resolveOrganizationById(organizationId);
  if (!organization || !isTenantLifecycleAccessible(organization.status)) return REFUSED;

  if (!(await hostPermits(input.host, organizationId))) return REFUSED;

  // A session from another tenant is never allowed to influence the guest path.
  const sessionUser =
    input.sessionUser?.organizationId === organizationId ? input.sessionUser : null;
  const guestToken = input.guestToken?.trim();
  const guestTokenHash = guestToken ? hashGuestToken(guestToken) : null;
  const now = input.now ?? new Date();

  const admitted = await withTenantDb(organizationId, async (db) => {
    const occurrence = await db.meetingOccurrence.findUnique({
      where: { publicId: input.publicId },
      select: {
        id: true,
        meetingId: true,
        providerRoomName: true,
        scheduledStart: true,
        scheduledEnd: true,
        joinOpensAt: true,
        joinClosesAt: true,
        status: true,
        cancelledAt: true,
        titleOverride: true,
        meeting: { select: { title: true, createdById: true } },
      },
    });
    if (!occurrence || !isJoinableOccurrence({ ...occurrence, now })) return null;

    if (
      sessionUser &&
      (await canAccessMeeting(db, sessionUser.id, sessionUser.role, occurrence.meetingId))
    ) {
      const participant = await db.meetingOccurrenceParticipant.findUnique({
        where: { occurrenceId_userId: { occurrenceId: occurrence.id, userId: sessionUser.id } },
        select: { roleOverride: true, removedAt: true, lobbyStatus: true },
      });
      if (participant?.removedAt || participant?.lobbyStatus === 'DENIED') return null;
      // A host may hold an invited member in the lobby too. Membership is
      // already proven at this point, so saying so grants nothing.
      if (participant?.lobbyStatus === 'WAITING') return WAITING;
      const role: MeetingParticipantRole =
        participant?.roleOverride ??
        (occurrence.meeting.createdById === sessionUser.id ? 'HOST' : 'ATTENDEE');
      return {
        occurrence,
        identity: createMeetingProviderIdentity('usr', sessionUser.id),
        displayName: 'Member',
        role,
      };
    }

    if (!guestTokenHash) return null;
    const participant = await db.meetingOccurrenceParticipant.findUnique({
      where: { guestTokenHash },
      select: {
        id: true,
        occurrenceId: true,
        displayName: true,
        roleOverride: true,
        guestTokenExpiresAt: true,
        guestTokenRevokedAt: true,
        removedAt: true,
        lobbyStatus: true,
      },
    });
    if (
      !participant ||
      participant.occurrenceId !== occurrence.id ||
      !participant.guestTokenExpiresAt ||
      participant.guestTokenExpiresAt < now ||
      participant.guestTokenRevokedAt ||
      participant.removedAt ||
      participant.lobbyStatus === 'DENIED'
    ) {
      return null;
    }
    // Ordered AFTER every credential check above, so a caller learns it is
    // waiting only once it has presented a valid, unexpired, unrevoked token
    // scoped to THIS occurrence. Reaching it proves the credential; it is not a
    // softer refusal for anyone who failed one of those checks.
    if (participant.lobbyStatus === 'WAITING') return WAITING;
    return {
      occurrence,
      identity: createMeetingProviderIdentity('gst', participant.id),
      displayName: participant.displayName,
      role: participant.roleOverride ?? 'ATTENDEE',
    };
  });

  if (!admitted) return REFUSED;
  if (admitted === WAITING) return { status: 'waiting' };
  const config = liveKitConfiguration();
  const mayPublish = admitted.role !== 'OBSERVER';
  const grant: VideoGrant = {
    room: admitted.occurrence.providerRoomName,
    roomJoin: true,
    canPublish: mayPublish,
    canPublishData: mayPublish,
    canSubscribe: true,
    roomAdmin: admitted.role === 'HOST' || admitted.role === 'COHOST',
  };
  const accessToken = new AccessToken(config.apiKey, config.apiSecret, {
    identity: admitted.identity,
    name: admitted.displayName,
    ttl: TOKEN_TTL_SECONDS,
    metadata: JSON.stringify({ role: admitted.role }),
  });
  accessToken.addGrant(grant);

  return {
    status: 'admitted',
    admission: {
      token: await accessToken.toJwt(),
      serverUrl: config.serverUrl,
      // The room name is deliberately absent: it is independently random so a
      // link holder cannot address the media room directly and skip the lobby
      // (MEET-004 D6). It travels only inside the signed grant.
      title: admitted.occurrence.titleOverride ?? admitted.occurrence.meeting.title,
      startsAt: admitted.occurrence.scheduledStart.toISOString(),
      endsAt: admitted.occurrence.scheduledEnd.toISOString(),
      role: admitted.role,
    },
  };
}
