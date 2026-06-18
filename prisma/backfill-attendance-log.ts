/**
 * One-off: copy any existing MeetingAttendee.joinedAt values into
 * MeetingAttendanceLog as a single log entry per attendee. Safe to re-run —
 * it's idempotent via the unique (meetingId, userId, occurrenceStart) index.
 *
 * Run locally:
 *   bunx tsx prisma/backfill-attendance-log.ts
 *
 * Run against prod Neon:
 *   DATABASE_URL='postgres://…' bunx tsx prisma/backfill-attendance-log.ts
 */
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { computeOccurrenceStart } from '../src/lib/meeting-occurrence';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const attendees = await prisma.meetingAttendee.findMany({
    where: { joinedAt: { not: null } },
    include: {
      meeting: { select: { startTime: true, recurrence: true } },
    },
  });

  console.log(`Found ${attendees.length} attendance records to backfill.`);

  let inserted = 0;
  let skipped = 0;
  for (const a of attendees) {
    const occurrenceStart = computeOccurrenceStart(
      a.meeting.startTime,
      a.meeting.recurrence,
      a.joinedAt!,
    );
    try {
      await prisma.meetingAttendanceLog.create({
        data: {
          meetingId: a.meetingId,
          userId: a.userId,
          occurrenceStart,
          joinedAt: a.joinedAt!,
        },
      });
      inserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unique')) {
        skipped++;
      } else {
        console.error(`Failed for (${a.meetingId}, ${a.userId}):`, msg);
      }
    }
  }

  console.log(`✓ Inserted ${inserted}, skipped ${skipped} (already existed).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
