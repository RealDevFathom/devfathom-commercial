import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';

export const MEETING_MATERIALIZATION_WINDOW_DAYS = 30;
const MINUTE_MS = 60_000;
type Db = PrismaClient | Prisma.TransactionClient;
type Series = {
  id: string;
  organizationId: string;
  startTime: Date;
  endTime: Date;
  recurrenceRule: string | null;
  materializedThrough: Date | null;
};

function nextSlot(value: Date, rule: string): Date {
  const next = new Date(value);
  const parts = new Map(rule.split(';').map((part) => part.split('=', 2) as [string, string]));
  const interval = Math.max(1, Number(parts.get('INTERVAL') ?? '1'));
  switch (parts.get('FREQ')) {
    case 'DAILY':
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case 'WEEKLY':
      next.setUTCDate(next.getUTCDate() + 7 * interval);
      break;
    case 'MONTHLY':
      next.setUTCMonth(next.getUTCMonth() + interval);
      break;
    default:
      throw new Error(`Unsupported meeting recurrence rule: ${rule}`);
  }
  return next;
}

/** Add missing slots through a rolling horizon. Existing/history rows are never deleted. */
export async function materializeMeetingOccurrences(db: Db, series: Series, now = new Date()) {
  const horizon = new Date(now.getTime() + MEETING_MATERIALIZATION_WINDOW_DAYS * 86_400_000);
  const duration = series.endTime.getTime() - series.startTime.getTime();
  if (duration <= 0) throw new Error('Meeting endTime must be after startTime.');
  let slot = series.materializedThrough
    ? series.recurrenceRule
      ? nextSlot(series.materializedThrough, series.recurrenceRule)
      : new Date(horizon.getTime() + 1)
    : new Date(series.startTime);
  const rows: Prisma.MeetingOccurrenceCreateManyInput[] = [];
  while (slot <= horizon) {
    rows.push({
      organizationId: series.organizationId,
      meetingId: series.id,
      seriesSlotStart: slot,
      scheduledStart: slot,
      scheduledEnd: new Date(slot.getTime() + duration),
      joinOpensAt: new Date(slot.getTime() - 15 * MINUTE_MS),
      joinClosesAt: new Date(slot.getTime() + duration + 60 * MINUTE_MS),
    });
    if (!series.recurrenceRule) break;
    slot = nextSlot(slot, series.recurrenceRule);
  }
  if (rows.length) await db.meetingOccurrence.createMany({ data: rows, skipDuplicates: true });
  const materializedThrough = rows.at(-1)?.seriesSlotStart ?? series.materializedThrough;
  if (materializedThrough) {
    await db.meeting.update({ where: { id: series.id }, data: { materializedThrough } });
  }
  const occurrences = await db.meetingOccurrence.findMany({
    where: { meetingId: series.id, seriesSlotStart: { lte: horizon } },
    orderBy: { seriesSlotStart: 'asc' },
  });
  const participants = await db.meetingParticipant.findMany({
    where: { meetingId: series.id },
    select: { id: true, userId: true, displayName: true },
  });
  if (occurrences.length && participants.length) {
    await db.meetingOccurrenceParticipant.createMany({
      data: occurrences.flatMap((occurrence) =>
        participants.map((participant) => ({
          organizationId: series.organizationId,
          occurrenceId: occurrence.id,
          participantId: participant.id,
          userId: participant.userId,
          displayName: participant.displayName,
        }))
      ),
      skipDuplicates: true,
    });
  }
  return occurrences;
}

export function rescheduleOccurrence(
  db: Db,
  occurrenceId: string,
  scheduledStart: Date,
  scheduledEnd: Date
) {
  if (scheduledEnd <= scheduledStart) throw new Error('Occurrence end must be after start.');
  return db.meetingOccurrence.update({
    where: { id: occurrenceId },
    data: { scheduledStart, scheduledEnd },
  });
}

export function cancelOccurrence(
  db: Db,
  occurrenceId: string,
  cancelledById: string,
  cancellationReason?: string
) {
  return db.meetingOccurrence.update({
    where: { id: occurrenceId },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById, cancellationReason },
  });
}

/** Raw secret is returned once; persistence receives only its SHA-256 digest. */
export async function issueGuestSecret(db: Db, occurrenceParticipantId: string, expiresAt: Date) {
  if (expiresAt <= new Date()) throw new Error('Guest secret expiry must be in the future.');
  const secret = randomBytes(32).toString('base64url');
  const guestTokenHash = hashGuestSecret(secret);
  await db.meetingOccurrenceParticipant.update({
    where: { id: occurrenceParticipantId },
    data: { guestTokenHash, guestTokenExpiresAt: expiresAt, guestTokenRevokedAt: null },
  });
  return secret;
}

export function hashGuestSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

export function guestSecretIsValid(
  grant: {
    guestTokenHash: string | null;
    guestTokenExpiresAt: Date | null;
    guestTokenRevokedAt: Date | null;
  },
  secret: string,
  now = new Date()
) {
  if (!grant.guestTokenHash || !grant.guestTokenExpiresAt || grant.guestTokenRevokedAt)
    return false;
  if (grant.guestTokenExpiresAt <= now) return false;
  const expected = Buffer.from(grant.guestTokenHash, 'hex');
  const actual = Buffer.from(hashGuestSecret(secret), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
