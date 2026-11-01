import 'server-only';

import { Prisma } from '@/generated/prisma/client';
import { withPlatformDb, withTenantDb, type ScopedDb } from '@/lib/tenancy/scoped-db';
import type { NormalizedMeetingEvent } from './types';

type OccurrenceRef = { id: string; organizationId: string };

function participantIdentityAttribution(identity: string) {
  const separator = identity.indexOf(':');
  if (separator === -1) {
    // Preserve support for identities created before admission began namespacing them.
    return { where: { OR: [{ id: identity }, { userId: identity }] }, userId: null };
  }

  const namespace = identity.slice(0, separator);
  const value = identity.slice(separator + 1);
  if (!value) return null;
  if (namespace === 'usr') {
    return { where: { userId: value }, userId: value };
  }
  if (namespace === 'gst') {
    return { where: { id: value }, userId: null };
  }

  return null;
}

export async function resolveProviderRoom(roomName: string): Promise<OccurrenceRef | null> {
  return withPlatformDb((db) =>
    db.meetingOccurrence.findUnique({
      where: { providerRoomName: roomName },
      select: { id: true, organizationId: true },
    })
  );
}

async function applyEvent(db: ScopedDb, occurrence: OccurrenceRef, event: NormalizedMeetingEvent) {
  if (event.type === 'room.started') {
    await db.$executeRaw(Prisma.sql`
      UPDATE "meeting_occurrences"
      SET "actualStart" = LEAST(COALESCE("actualStart", ${event.occurredAt}), ${event.occurredAt}),
          "status" = CASE WHEN "status" IN ('ENDED', 'CANCELLED') THEN "status" ELSE 'ACTIVE'::"MeetingOccurrenceStatus" END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${occurrence.id}
    `);
    return;
  }
  if (event.type === 'room.finished') {
    await db.$executeRaw(Prisma.sql`
      UPDATE "meeting_occurrences"
      SET "actualEnd" = GREATEST(COALESCE("actualEnd", ${event.occurredAt}), ${event.occurredAt}),
          "status" = CASE WHEN "status" = 'CANCELLED' THEN "status" ELSE 'ENDED'::"MeetingOccurrenceStatus" END,
          "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = ${occurrence.id}
    `);
    await db.meetingParticipantSession.updateMany({
      where: { occurrenceId: occurrence.id, leftAt: null },
      data: { leftAt: event.occurredAt, disconnectReason: 'room.finished' },
    });
    return;
  }
  if (event.type === 'unmapped') return;
  if (!event.participantId || !event.participantIdentity) {
    throw new Error('Normalized participant event is missing participant identity');
  }

  const attribution = participantIdentityAttribution(event.participantIdentity);
  const grant = attribution
    ? await db.meetingOccurrenceParticipant.findFirst({
        where: { occurrenceId: occurrence.id, ...attribution.where },
        select: { id: true, userId: true },
      })
    : null;
  const userId = grant?.userId ?? attribution?.userId ?? null;

  if (event.type === 'participant.joined') {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "meeting_participant_sessions"
        ("id", "organizationId", "occurrenceId", "occurrenceParticipantId", "userId",
         "providerParticipantSid", "source", "joinedAt", "joinEventId")
      VALUES
        (${crypto.randomUUID()}, ${occurrence.organizationId}, ${occurrence.id}, ${grant?.id ?? null},
         ${userId}, ${event.participantId}, 'WEBHOOK', ${event.occurredAt}, ${event.id})
      ON CONFLICT ("organizationId", "providerParticipantSid") DO UPDATE SET
        "joinedAt" = LEAST("meeting_participant_sessions"."joinedAt", EXCLUDED."joinedAt"),
        "joinEventId" = EXCLUDED."joinEventId",
        "occurrenceParticipantId" = COALESCE("meeting_participant_sessions"."occurrenceParticipantId", EXCLUDED."occurrenceParticipantId"),
        "userId" = COALESCE("meeting_participant_sessions"."userId", EXCLUDED."userId")
    `);
    return;
  }

  await db.$executeRaw(Prisma.sql`
    INSERT INTO "meeting_participant_sessions"
      ("id", "organizationId", "occurrenceId", "occurrenceParticipantId", "userId",
       "providerParticipantSid", "source", "joinedAt", "leftAt", "leaveEventId", "disconnectReason")
    VALUES
      (${crypto.randomUUID()}, ${occurrence.organizationId}, ${occurrence.id}, ${grant?.id ?? null},
       ${userId}, ${event.participantId}, 'WEBHOOK', ${event.occurredAt},
       ${event.occurredAt}, ${event.id}, 'provider')
    ON CONFLICT ("organizationId", "providerParticipantSid") DO UPDATE SET
      "leftAt" = GREATEST(COALESCE("meeting_participant_sessions"."leftAt", EXCLUDED."leftAt"), EXCLUDED."leftAt"),
      "leaveEventId" = EXCLUDED."leaveEventId",
      "disconnectReason" = EXCLUDED."disconnectReason",
      "occurrenceParticipantId" = COALESCE("meeting_participant_sessions"."occurrenceParticipantId", EXCLUDED."occurrenceParticipantId"),
      "userId" = COALESCE("meeting_participant_sessions"."userId", EXCLUDED."userId")
  `);
}

export async function recordAndApplyProviderEvent(
  occurrence: OccurrenceRef,
  event: NormalizedMeetingEvent
): Promise<'processed' | 'duplicate'> {
  return withTenantDb(occurrence.organizationId, async (db) => {
    const inserted = await db.meetingProviderEvent.createMany({
      data: {
        organizationId: occurrence.organizationId,
        occurrenceId: occurrence.id,
        providerEventId: event.id,
        eventType: event.providerType,
        payload: event.payload as Prisma.InputJsonValue,
      },
      skipDuplicates: true,
    });
    if (inserted.count === 0) return 'duplicate';

    await applyEvent(db, occurrence, event);
    await db.meetingProviderEvent.update({
      where: {
        organizationId_providerEventId: {
          organizationId: occurrence.organizationId,
          providerEventId: event.id,
        },
      },
      data: { processedAt: new Date() },
    });
    return 'processed';
  });
}
