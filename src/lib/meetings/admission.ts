import 'server-only';

import { createHash } from 'node:crypto';
import { AccessToken, type VideoGrant } from 'livekit-server-sdk';
import { canAccessMeeting } from '@/lib/authz';
import type { MeetingParticipantRole } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb } from '@/lib/tenancy/scoped-db';

const PUBLIC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_TTL_SECONDS = 10 * 60;

export const GENERIC_ADMISSION_ERROR = 'This meeting is unavailable or the access code is invalid.';

export type MeetingAdmission = {
  token: string;
  serverUrl: string;
  title: string;
  startsAt: string;
  endsAt: string;
  role: MeetingParticipantRole;
};

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

async function organizationForPublicId(publicId: string): Promise<string | null> {
  if (!PUBLIC_ID.test(publicId)) return null;
  return withPlatformDb(async (db) => {
    const occurrence = await db.meetingOccurrence.findUnique({
      where: { publicId },
      select: { organizationId: true },
    });
    return occurrence?.organizationId ?? null;
  });
}

function liveKitConfiguration() {
  const serverUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!serverUrl || !apiKey || !apiSecret) throw new Error('Meeting media is not configured.');
  return { serverUrl, apiKey, apiSecret };
}

export async function admitToMeeting(input: {
  publicId: string;
  guestToken?: string | null;
  sessionUser?: { id: string; organizationId: string; role?: string | null } | null;
  now?: Date;
}): Promise<MeetingAdmission | null> {
  const organizationId = await organizationForPublicId(input.publicId);
  if (!organizationId) return null;

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
      const role: MeetingParticipantRole =
        participant?.roleOverride ??
        (occurrence.meeting.createdById === sessionUser.id ? 'HOST' : 'ATTENDEE');
      return {
        occurrence,
        identity: `usr:${sessionUser.id}`,
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
      participant.lobbyStatus === 'DENIED' ||
      participant.lobbyStatus === 'WAITING'
    ) {
      return null;
    }
    return {
      occurrence,
      identity: `gst:${participant.id}`,
      displayName: participant.displayName,
      role: participant.roleOverride ?? 'ATTENDEE',
    };
  });

  if (!admitted) return null;
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
    token: await accessToken.toJwt(),
    serverUrl: config.serverUrl,
    title: admitted.occurrence.titleOverride ?? admitted.occurrence.meeting.title,
    startsAt: admitted.occurrence.scheduledStart.toISOString(),
    endsAt: admitted.occurrence.scheduledEnd.toISOString(),
    role: admitted.role,
  };
}
