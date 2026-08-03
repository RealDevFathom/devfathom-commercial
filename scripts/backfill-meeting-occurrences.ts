/**
 * MEET-01 backfill gate.
 *
 * The data change itself lives in the migration
 * (prisma/migrations/20260803120000_meeting_occurrences), and it has to: the
 * migration adds `meetings.timezone` as NOT NULL, so the values must exist by
 * the time the statement commits. Re-implementing the same backfill here would
 * give the release two sources of truth that could disagree.
 *
 * What this script owns is the part a migration cannot do: telling a human what
 * the migration is about to find, before it finds it, and proving afterwards
 * that nothing was lost.
 *
 *   bun run tsx scripts/backfill-meeting-occurrences.ts            # pre-flight inventory
 *   bun run tsx scripts/backfill-meeting-occurrences.ts --verify   # post-migration proof
 *
 * Both modes are READ ONLY and exit non-zero when the database is not in a
 * state the migration can handle. Point them at a database with
 * MEETING_BACKFILL_DATABASE_URL, or fall back to DATABASE_URL.
 */
import pg from 'pg';

const { Client } = pg;

const databaseUrl = process.env.MEETING_BACKFILL_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('MEETING_BACKFILL_DATABASE_URL or DATABASE_URL is required.');
}

const verifyMode = process.argv.includes('--verify');
const client = new Client({ connectionString: databaseUrl });

/** daily -> FREQ=DAILY, biweekly -> FREQ=WEEKLY;INTERVAL=2, and so on. */
const RECURRENCE_TO_RRULE = new Map<string, string>([
  ['daily', 'FREQ=DAILY'],
  ['weekly', 'FREQ=WEEKLY'],
  ['biweekly', 'FREQ=WEEKLY;INTERVAL=2'],
  ['monthly', 'FREQ=MONTHLY'],
]);

const problems: string[] = [];

function report(title: string, rows: Array<Record<string, unknown>>) {
  console.log(`\n${title}`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  console.table(rows);
}

async function inventory() {
  const recurrence = await client.query<{ value: string | null; meetings: string }>(
    `SELECT "recurrence" AS value, count(*)::text AS meetings
       FROM "meetings"
      GROUP BY 1
      ORDER BY 1 NULLS FIRST`
  );

  const mapping = recurrence.rows.map((row) => {
    const raw = row.value;
    const normalized = raw?.trim().toLowerCase() ?? '';
    const rrule = normalized === '' ? null : (RECURRENCE_TO_RRULE.get(normalized) ?? undefined);
    return {
      'recurrence (raw)': raw === null ? '<NULL>' : JSON.stringify(raw),
      normalized: normalized === '' ? '<one-time>' : normalized,
      recurrenceRule: rrule === undefined ? 'UNMAPPABLE' : (rrule ?? '<NULL>'),
      meetings: Number(row.meetings),
    };
  });
  report('Recurrence inventory and RRULE mapping', mapping);

  const unmappable = mapping.filter((row) => row.recurrenceRule === 'UNMAPPABLE');
  if (unmappable.length > 0) {
    problems.push(
      `${unmappable.length} recurrence value(s) have no RRULE mapping: ${unmappable
        .map((row) => `${row['recurrence (raw)']} (${row.meetings} meetings)`)
        .join(', ')}. A human must map each one; the migration will not guess.`
    );
  }

  const timezones = await client.query<{
    organizationId: string;
    timezone: string | null;
    valid: boolean | null;
    meetings: string;
  }>(
    // Inline rather than is_iana_timezone(): the inventory has to run BEFORE
    // the migration that creates that function.
    `SELECT meeting."organizationId" AS "organizationId",
            organization."timezone"  AS "timezone",
            EXISTS (SELECT 1 FROM pg_timezone_names AS zone WHERE zone.name = organization."timezone") AS valid,
            count(*)::text           AS meetings
       FROM "meetings" AS meeting
       LEFT JOIN "organizations" AS organization ON organization."id" = meeting."organizationId"
      GROUP BY 1, 2, 3
      ORDER BY 1`
  );
  report(
    'Timezone sources (derived from the owning organization)',
    timezones.rows.map((row) => ({
      organization: row.organizationId,
      'organization.timezone': row.timezone ?? '<no organization row>',
      'valid IANA': row.valid === true ? 'yes' : 'no',
      meetings: Number(row.meetings),
    }))
  );

  const undeterminable = timezones.rows.filter((row) => row.valid !== true);
  if (undeterminable.length > 0) {
    problems.push(
      `${undeterminable.reduce((sum, row) => sum + Number(row.meetings), 0)} meeting(s) have no valid IANA timezone to derive from: ${undeterminable
        .map((row) => `${row.organizationId} -> ${row.timezone ?? '<no organization row>'}`)
        .join(', ')}. UTC is not a safe guess for a recurring series.`
    );
  }

  const shape = await client.query<{
    backwards_meetings: string;
    backwards_attendance: string;
    divergent_attendance: string;
    divergent_instances: string;
  }>(
    `SELECT
       (SELECT count(*) FROM "meetings" WHERE "endTime" < "startTime")::text AS backwards_meetings,
       (SELECT count(*) FROM "meeting_attendance_log"
         WHERE "leftAt" IS NOT NULL AND "leftAt" < "joinedAt")::text AS backwards_attendance,
       (SELECT count(*) FROM "meeting_attendance_log" AS log
          JOIN "meetings" AS meeting ON meeting."id" = log."meetingId"
         WHERE log."occurrenceStart" <> meeting."startTime")::text AS divergent_attendance,
       (SELECT count(*) FROM (
          SELECT DISTINCT log."meetingId", log."occurrenceStart"
            FROM "meeting_attendance_log" AS log
            JOIN "meetings" AS meeting ON meeting."id" = log."meetingId"
           WHERE log."occurrenceStart" <> meeting."startTime") AS instances)::text AS divergent_instances`
  );
  const row = shape.rows[0]!;
  report('Shape checks', [
    { check: 'meetings ending before they start', rows: Number(row.backwards_meetings) },
    { check: 'attendance leaving before joining', rows: Number(row.backwards_attendance) },
    {
      check: 'attendance not at its meeting start instant',
      rows: Number(row.divergent_attendance),
    },
    {
      check: 'extra occurrences those rows will materialise',
      rows: Number(row.divergent_instances),
    },
  ]);

  if (Number(row.backwards_meetings) > 0) {
    problems.push(
      `${row.backwards_meetings} meeting(s) end before they start; the migration refuses to clamp them.`
    );
  }
  if (Number(row.backwards_attendance) > 0) {
    problems.push(
      `${row.backwards_attendance} attendance row(s) leave before they join; the migration refuses to discard leftAt.`
    );
  }
  if (Number(row.divergent_instances) > 0) {
    console.log(
      `\nNote: recurrence was never materialised, so the backfill is 1:1 per meeting — except for ${row.divergent_instances} extra occurrence(s) created to keep the attendance above addressable. This is reported, never silent.`
    );
  }

  const totals = await client.query(
    `SELECT
       (SELECT count(*) FROM "meetings")::text               AS meetings,
       (SELECT count(*) FROM "meeting_attendees")::text       AS attendees,
       (SELECT count(*) FROM "meeting_attendance_log")::text  AS attendance_log`
  );
  report(
    'Source row counts',
    Object.entries(totals.rows[0] as Record<string, string>).map(([table, count]) => ({
      table,
      rows: Number(count),
    }))
  );
}

async function verify() {
  const counts = await client.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM "meetings")::text                        AS meetings,
       (SELECT count(*) FROM "meeting_occurrences")::text             AS occurrences,
       (SELECT count(*) FROM "meeting_attendees")::text               AS attendees,
       (SELECT count(*) FROM "meeting_participants")::text            AS participants,
       (SELECT count(*) FROM "meeting_attendance_log")::text          AS attendance_log,
       (SELECT count(*) FROM "meeting_participant_sessions")::text    AS sessions,
       (SELECT count(*) FROM "meeting_participant_sessions"
         WHERE "source" = 'LEGACY_CLIENT')::text                      AS legacy_sessions,
       (SELECT count(*) FROM "meeting_participant_sessions"
         WHERE "providerParticipantSid" IS NOT NULL)::text            AS sessions_with_provider_sid`
  );
  report(
    'Post-migration counts',
    Object.entries(counts.rows[0]!).map(([table, count]) => ({ table, rows: Number(count) }))
  );

  const gaps = await client.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM "meetings" AS meeting
         WHERE NOT EXISTS (SELECT 1 FROM "meeting_occurrences" AS occurrence
                            WHERE occurrence."meetingId" = meeting."id"))::text AS meetings_without_occurrence,
       (SELECT count(*) FROM "meetings" WHERE "timezone" IS NULL)::text          AS meetings_without_timezone,
       (SELECT count(*) FROM "meetings"
         WHERE "recurrence" IS NOT NULL AND btrim("recurrence") <> ''
           AND "recurrenceRule" IS NULL)::text                                   AS recurrence_without_rrule,
       (SELECT count(*) FROM "meeting_attendees" AS attendee
         WHERE NOT EXISTS (SELECT 1 FROM "meeting_participants" AS participant
                            WHERE participant."meetingId" = attendee."meetingId"
                              AND participant."userId" = attendee."userId"))::text AS attendees_without_participant,
       (SELECT count(*) FROM "meeting_attendance_log" AS log
         WHERE NOT EXISTS (SELECT 1 FROM "meeting_participant_sessions" AS session
                             JOIN "meeting_occurrences" AS occurrence ON occurrence."id" = session."occurrenceId"
                            WHERE occurrence."meetingId" = log."meetingId"
                              AND occurrence."seriesSlotStart" = log."occurrenceStart"
                              AND session."userId" = log."userId"
                              AND session."joinedAt" = log."joinedAt"))::text     AS attendance_without_session,
       (SELECT count(*) FROM "meeting_occurrences" AS occurrence
          JOIN "meetings" AS meeting ON meeting."id" = occurrence."meetingId"
         WHERE occurrence."organizationId" <> meeting."organizationId")::text     AS cross_tenant_occurrences,
       (SELECT count(*) FROM "meeting_occurrences"
         WHERE "publicId" IS NULL OR "providerRoomName" IS NULL)::text            AS occurrences_missing_identifiers,
       (SELECT count(*) - count(DISTINCT "publicId") FROM "meeting_occurrences")::text AS duplicate_public_ids,
       (SELECT count(*) - count(DISTINCT "providerRoomName") FROM "meeting_occurrences")::text AS duplicate_room_names,
       (SELECT count(*) FROM "meeting_occurrences"
         WHERE "providerRoomName" LIKE '%' || "publicId" || '%')::text            AS room_names_derived_from_public_id,
       (SELECT count(*) FROM "meetings" AS meeting
          JOIN "meeting_occurrences" AS occurrence ON occurrence."meetingId" = meeting."id"
         WHERE meeting."materializedThrough" IS NULL
            OR meeting."materializedThrough" < occurrence."seriesSlotStart")::text AS watermark_behind_occurrences`
  );

  const gapRows = Object.entries(gaps.rows[0]!).map(([check, value]) => ({
    check,
    rows: Number(value),
  }));
  report('Completeness checks (every one must be 0)', gapRows);
  for (const gapRow of gapRows) {
    if (gapRow.rows !== 0) problems.push(`${gapRow.check}: ${gapRow.rows}`);
  }

  // The series-level invitee table must never gain a credential column. This is
  // the boundary that erodes quietly, so it is checked against the live catalog
  // rather than against the schema file someone might have edited.
  const credentialColumns = await client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'meeting_participants'
        AND (column_name ILIKE '%token%'
          OR column_name ILIKE '%secret%'
          OR column_name ILIKE '%password%'
          OR column_name ILIKE '%hash%'
          OR column_name ILIKE '%credential%'
          OR column_name ILIKE '%expires%')
      ORDER BY 1`
  );
  report(
    'Credential-shaped columns on meeting_participants (must be none)',
    credentialColumns.rows
  );
  if (credentialColumns.rows.length > 0) {
    problems.push(
      `meeting_participants gained credential-shaped column(s): ${credentialColumns.rows
        .map((row) => row.column_name)
        .join(', ')}. Nothing credential-bearing may span a recurring series.`
    );
  }
}

async function main() {
  await client.connect();
  try {
    // Reading tenant tables from outside a tenant transaction requires the
    // platform scope; without it FORCE RLS would hide every row and this gate
    // would pass by seeing nothing.
    await client.query(`SELECT set_config('app.is_platform_admin', 'true', false)`);
    if (verifyMode) await verify();
    else await inventory();
  } finally {
    await client.end();
  }

  if (problems.length > 0) {
    console.error('\nMEET-01 backfill gate FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nMEET-01 backfill gate passed (${verifyMode ? 'verify' : 'inventory'}).`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
