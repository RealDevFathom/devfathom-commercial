-- MEET-01: additive meeting occurrence and participant schema.
--
-- A Meeting becomes a SERIES. Everything joinable, everything evidential, and
-- every guest credential moves onto a MeetingOccurrence — the individual
-- instance. Nothing is dropped or renamed: `meetings.recurrence` keeps being
-- written and read through the migration window, and reverting the application
-- to pre-MEET-01 code leaves this database fully usable.
--
-- Occurrence materialisation is LAZY and BOUNDED. This migration materialises
-- exactly the instances that already exist as data (one per meeting, plus one
-- for any historical attendance row that names a different instant). Future
-- instances are produced by walking the RRULE forward only to
-- now() + 30 days and recording the horizon in `meetings.materializedThrough`,
-- so an open-ended series can never expand without bound. The window constant
-- is enforced by the materialiser that a later PR adds; this migration
-- enforces the shape it depends on — at most one row per (series, slot).

-- ---------------------------------------------------------------------------
-- 0. Refuse to run blind.
-- ---------------------------------------------------------------------------
-- `meetings` already FORCEs row level security, and FORCE applies to the table
-- owner too. If this migration ran without a platform scope under a
-- non-bypassing role, every SELECT below would return zero rows and the
-- backfill would "succeed" having copied nothing. Take the platform scope for
-- the duration of the migration transaction, then prove it took effect.
SELECT set_config('app.is_platform_admin', 'true', true);

DO $$
BEGIN
  IF row_security_active('meetings')
     AND current_setting('app.is_platform_admin', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'MEET-01: row level security is active for role % on "meetings" and no platform scope is set. The backfill would silently see no rows; aborting.',
      current_user;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Helper functions.
-- ---------------------------------------------------------------------------

-- ponytail: IMMUTABLE is a deliberate white lie. pg_timezone_names is derived
-- from the system tz database, which changes when the OS ships new tzdata, so
-- this function is really STABLE. PostgreSQL only accepts IMMUTABLE functions
-- inside CHECK constraints, and the alternative — no validation at all — is
-- worse than the risk that a zone is retired years after a row was written.
-- Rows are validated on write and never re-validated. If tzdata churn ever
-- matters, replace the CHECK with a nightly reconciliation job.
CREATE OR REPLACE FUNCTION is_iana_timezone(value text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT value IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = value);
$$;

-- RFC 4648 base32 over a bytea, unpadded, uppercase alphabet.
CREATE OR REPLACE FUNCTION meeting_base32(data bytea)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT string_agg(
    substr(
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
      1 + (
        (
          (
            get_byte(data, (chunk * 5) / 8) * 256
            + CASE
                WHEN (chunk * 5) / 8 + 1 < octet_length(data)
                  THEN get_byte(data, (chunk * 5) / 8 + 1)
                ELSE 0
              END
          ) >> (11 - ((chunk * 5) % 8))
        ) & 31
      ),
      1
    ),
    ''
    ORDER BY chunk
  )
  FROM generate_series(0, ceil(octet_length(data) * 8 / 5.0)::int - 1) AS chunk;
$$;

-- Media room name: 'mtg_' plus 16 cryptographically random bytes in base32.
-- gen_random_uuid() is PostgreSQL's CSPRNG-backed UUIDv4, so this needs no
-- extension. It is a column DEFAULT so no caller can forget it, and it is
-- generated INDEPENDENTLY of publicId: a room name derivable from the join
-- link would let anyone holding a link address the media room directly and
-- walk past the lobby.
CREATE OR REPLACE FUNCTION meeting_provider_room_name()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT 'mtg_' || meeting_base32(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'));
$$;

-- `meetings.timezone` is NOT NULL, but pre-MEET-01 application code does not
-- write it. Rather than default the column to a guessed 'UTC', derive it from
-- the owning organization. The column default is an empty-string placeholder
-- that this trigger always replaces before any constraint sees it, so a blank
-- zone can never reach storage; the CHECK below proves it. A writer that
-- supplies a zone keeps it; one that does not gets the tenant's own zone or a
-- loud failure — never a silent guess. This is what lets MEET-01 ship without
-- touching src/.
CREATE OR REPLACE FUNCTION meeting_timezone_from_organization()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."timezone" IS NULL OR btrim(NEW."timezone") = '' THEN
    SELECT organization."timezone"
      INTO NEW."timezone"
      FROM "organizations" AS organization
     WHERE organization."id" = NEW."organizationId";
  END IF;

  IF NEW."timezone" IS NULL OR btrim(NEW."timezone") = '' THEN
    RAISE EXCEPTION
      'meetings.timezone could not be derived: organization % has no timezone.',
      NEW."organizationId";
  END IF;

  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Enums.
-- ---------------------------------------------------------------------------
CREATE TYPE "MeetingOccurrenceStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'OPEN', 'ACTIVE', 'ENDING', 'ENDED', 'CANCELLED');
CREATE TYPE "MeetingParticipantRole" AS ENUM ('HOST', 'COHOST', 'PRESENTER', 'ATTENDEE', 'OBSERVER');
CREATE TYPE "MeetingInviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'TENTATIVE');
CREATE TYPE "MeetingLobbyStatus" AS ENUM ('NOT_REQUIRED', 'WAITING', 'ADMITTED', 'DENIED');
CREATE TYPE "MeetingSessionSource" AS ENUM ('WEBHOOK', 'LEGACY_CLIENT', 'MANUAL');

-- ---------------------------------------------------------------------------
-- 3. Meeting series: additive columns.
-- ---------------------------------------------------------------------------
ALTER TABLE "meetings"
    ADD COLUMN "recurrenceRule" TEXT,
    ADD COLUMN "timezone" TEXT,
    ADD COLUMN "materializedThrough" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 4. Recurrence and timezone migration. Both fail loudly rather than default.
-- ---------------------------------------------------------------------------

-- daily -> FREQ=DAILY, weekly -> FREQ=WEEKLY, biweekly -> FREQ=WEEKLY;INTERVAL=2,
-- monthly -> FREQ=MONTHLY. Anything else is left NULL and caught below.
UPDATE "meetings"
   SET "recurrenceRule" = CASE lower(btrim("recurrence"))
         WHEN 'daily'    THEN 'FREQ=DAILY'
         WHEN 'weekly'   THEN 'FREQ=WEEKLY'
         WHEN 'biweekly' THEN 'FREQ=WEEKLY;INTERVAL=2'
         WHEN 'monthly'  THEN 'FREQ=MONTHLY'
       END
 WHERE "recurrence" IS NOT NULL
   AND btrim("recurrence") <> '';

DO $$
DECLARE
  unmapped text;
BEGIN
  SELECT string_agg(format('%L (%s meetings)', value, meetings), ', ' ORDER BY value)
    INTO unmapped
    FROM (
      SELECT "recurrence" AS value, count(*) AS meetings
        FROM "meetings"
       WHERE "recurrence" IS NOT NULL
         AND btrim("recurrence") <> ''
         AND "recurrenceRule" IS NULL
       GROUP BY 1
    ) AS unmappable;

  IF unmapped IS NOT NULL THEN
    RAISE EXCEPTION
      'MEET-01: Meeting.recurrence values with no RRULE mapping. A human must map each one before this migration can run: %',
      unmapped;
  END IF;
END $$;

-- Timezone comes from the owning organization. Never from a guess.
UPDATE "meetings" AS meeting
   SET "timezone" = organization."timezone"
  FROM "organizations" AS organization
 WHERE organization."id" = meeting."organizationId"
   AND is_iana_timezone(organization."timezone");

DO $$
DECLARE
  undeterminable text;
BEGIN
  SELECT string_agg(
           format('organization %L (%s meetings, organization timezone %L)', organization_id, meetings, timezone),
           ', ' ORDER BY organization_id
         )
    INTO undeterminable
    FROM (
      SELECT meeting."organizationId" AS organization_id,
             count(*)                 AS meetings,
             max(organization."timezone") AS timezone
        FROM "meetings" AS meeting
        LEFT JOIN "organizations" AS organization
          ON organization."id" = meeting."organizationId"
       WHERE meeting."timezone" IS NULL
       GROUP BY 1
    ) AS missing;

  IF undeterminable IS NOT NULL THEN
    RAISE EXCEPTION
      'MEET-01: no valid IANA timezone could be derived for these meetings, and UTC is not a safe guess for a recurring series: %',
      undeterminable;
  END IF;
END $$;

-- Backwards data cannot produce a coherent occurrence or session. Surface it
-- rather than clamping it into something plausible.
DO $$
DECLARE
  backwards bigint;
BEGIN
  SELECT count(*) INTO backwards FROM "meetings" WHERE "endTime" < "startTime";
  IF backwards > 0 THEN
    RAISE EXCEPTION
      'MEET-01: % meetings end before they start; a human must correct them before occurrences can be materialised.',
      backwards;
  END IF;

  SELECT count(*) INTO backwards
    FROM "meeting_attendance_log"
   WHERE "leftAt" IS NOT NULL AND "leftAt" < "joinedAt";
  IF backwards > 0 THEN
    RAISE EXCEPTION
      'MEET-01: % attendance rows leave before they join; a human must correct them rather than have the backfill quietly discard leftAt.',
      backwards;
  END IF;
END $$;

ALTER TABLE "meetings"
    ALTER COLUMN "timezone" SET NOT NULL,
    ALTER COLUMN "timezone" SET DEFAULT '';

CREATE TRIGGER "meetings_timezone_from_organization"
BEFORE INSERT OR UPDATE ON "meetings"
FOR EACH ROW
EXECUTE FUNCTION meeting_timezone_from_organization();

ALTER TABLE "meetings"
    ADD CONSTRAINT "meetings_timezone_iana_check" CHECK (is_iana_timezone("timezone")),
    ADD CONSTRAINT "meetings_recurrenceRule_shape_check" CHECK (
      "recurrenceRule" IS NULL
      OR "recurrenceRule" ~ '^FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[^;]+)*$'
    );

CREATE INDEX "meetings_organizationId_materializedThrough_idx"
    ON "meetings"("organizationId", "materializedThrough");

-- ---------------------------------------------------------------------------
-- 5. New tables.
-- ---------------------------------------------------------------------------
CREATE TABLE "meeting_occurrences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "meetingId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "seriesSlotStart" TIMESTAMP(3) NOT NULL,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "scheduledEnd" TIMESTAMP(3) NOT NULL,
    "actualStart" TIMESTAMP(3),
    "actualEnd" TIMESTAMP(3),
    "status" "MeetingOccurrenceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "providerRoomName" TEXT NOT NULL DEFAULT meeting_provider_room_name(),
    "joinOpensAt" TIMESTAMP(3) NOT NULL,
    "joinClosesAt" TIMESTAMP(3) NOT NULL,
    "titleOverride" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_occurrences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_participants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "meetingId" TEXT NOT NULL,
    "userId" TEXT,
    "clientContactId" TEXT,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "defaultRole" "MeetingParticipantRole" NOT NULL DEFAULT 'ATTENDEE',
    "invitationStatus" "MeetingInviteStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_occurrence_participants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "occurrenceId" TEXT NOT NULL,
    "participantId" TEXT,
    "userId" TEXT,
    "displayName" TEXT NOT NULL,
    "lobbyStatus" "MeetingLobbyStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "roleOverride" "MeetingParticipantRole",
    "recordingConsent" BOOLEAN,
    "recordingConsentAt" TIMESTAMP(3),
    "admittedAt" TIMESTAMP(3),
    "admittedById" TEXT,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "guestTokenHash" TEXT,
    "guestTokenExpiresAt" TIMESTAMP(3),
    "guestTokenRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_occurrence_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_participant_sessions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "occurrenceId" TEXT NOT NULL,
    "occurrenceParticipantId" TEXT,
    "userId" TEXT,
    "providerParticipantSid" TEXT,
    "source" "MeetingSessionSource" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL,
    "leftAt" TIMESTAMP(3),
    "disconnectReason" TEXT,
    "joinEventId" TEXT,
    "leaveEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_participant_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_provider_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "occurrenceId" TEXT,
    "providerEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "failureReason" TEXT,

    CONSTRAINT "meeting_provider_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "meeting_entity_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "meetingId" TEXT NOT NULL,
    "projectId" TEXT,
    "clientId" TEXT,
    "channelId" TEXT,
    "noteId" TEXT,
    "taskId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_entity_links_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 6. Indexes.
-- ---------------------------------------------------------------------------

-- publicId is GLOBALLY unique, not per tenant. A join link arrives on a shared
-- host that names no organization, so the identifier alone must resolve to
-- exactly one tenant — the same reason Invitation.tokenHash and
-- PasswordResetToken.tokenHash are globally unique. See
-- src/lib/auth/anonymous-tenant.ts.
CREATE UNIQUE INDEX "meeting_occurrences_publicId_key" ON "meeting_occurrences"("publicId");
CREATE UNIQUE INDEX "meeting_occurrences_providerRoomName_key" ON "meeting_occurrences"("providerRoomName");
CREATE UNIQUE INDEX "meeting_occurrences_meetingId_seriesSlotStart_key" ON "meeting_occurrences"("meetingId", "seriesSlotStart");
CREATE INDEX "meeting_occurrences_organizationId_idx" ON "meeting_occurrences"("organizationId");
CREATE INDEX "meeting_occurrences_organizationId_scheduledStart_idx" ON "meeting_occurrences"("organizationId", "scheduledStart");
CREATE INDEX "meeting_occurrences_organizationId_status_scheduledStart_idx" ON "meeting_occurrences"("organizationId", "status", "scheduledStart");
CREATE INDEX "meeting_occurrences_meetingId_scheduledStart_idx" ON "meeting_occurrences"("meetingId", "scheduledStart");

CREATE UNIQUE INDEX "meeting_participants_meetingId_userId_key" ON "meeting_participants"("meetingId", "userId");
CREATE UNIQUE INDEX "meeting_participants_meetingId_clientContactId_key" ON "meeting_participants"("meetingId", "clientContactId");
CREATE UNIQUE INDEX "meeting_participants_meetingId_email_key" ON "meeting_participants"("meetingId", "email");
CREATE INDEX "meeting_participants_organizationId_idx" ON "meeting_participants"("organizationId");
CREATE INDEX "meeting_participants_organizationId_userId_idx" ON "meeting_participants"("organizationId", "userId");

CREATE UNIQUE INDEX "meeting_occurrence_participants_guestTokenHash_key" ON "meeting_occurrence_participants"("guestTokenHash");
CREATE UNIQUE INDEX "meeting_occurrence_participants_occurrenceId_participantId_key" ON "meeting_occurrence_participants"("occurrenceId", "participantId");
CREATE UNIQUE INDEX "meeting_occurrence_participants_occurrenceId_userId_key" ON "meeting_occurrence_participants"("occurrenceId", "userId");
CREATE INDEX "meeting_occurrence_participants_organizationId_idx" ON "meeting_occurrence_participants"("organizationId");
CREATE INDEX "meeting_occurrence_participants_organizationId_occurrenceId_idx" ON "meeting_occurrence_participants"("organizationId", "occurrenceId", "lobbyStatus");
CREATE INDEX "meeting_occurrence_participants_guestTokenExpiresAt_idx" ON "meeting_occurrence_participants"("guestTokenExpiresAt");

CREATE UNIQUE INDEX "meeting_participant_sessions_organizationId_providerPartici_key" ON "meeting_participant_sessions"("organizationId", "providerParticipantSid");
CREATE INDEX "meeting_participant_sessions_organizationId_idx" ON "meeting_participant_sessions"("organizationId");
CREATE INDEX "meeting_participant_sessions_occurrenceId_joinedAt_idx" ON "meeting_participant_sessions"("occurrenceId", "joinedAt");
CREATE INDEX "meeting_participant_sessions_userId_joinedAt_idx" ON "meeting_participant_sessions"("userId", "joinedAt");

-- Per tenant, deliberately not global: a globally unique provider event id
-- would make one tenant's insert fail because another tenant had already
-- received that event, which leaks the existence of another tenant's event.
CREATE UNIQUE INDEX "meeting_provider_events_organizationId_providerEventId_key" ON "meeting_provider_events"("organizationId", "providerEventId");
CREATE INDEX "meeting_provider_events_organizationId_receivedAt_idx" ON "meeting_provider_events"("organizationId", "receivedAt");
CREATE INDEX "meeting_provider_events_occurrenceId_receivedAt_idx" ON "meeting_provider_events"("occurrenceId", "receivedAt");

CREATE UNIQUE INDEX "meeting_entity_links_meetingId_projectId_key" ON "meeting_entity_links"("meetingId", "projectId");
CREATE UNIQUE INDEX "meeting_entity_links_meetingId_clientId_key" ON "meeting_entity_links"("meetingId", "clientId");
CREATE UNIQUE INDEX "meeting_entity_links_meetingId_channelId_key" ON "meeting_entity_links"("meetingId", "channelId");
CREATE UNIQUE INDEX "meeting_entity_links_meetingId_noteId_key" ON "meeting_entity_links"("meetingId", "noteId");
CREATE UNIQUE INDEX "meeting_entity_links_meetingId_taskId_key" ON "meeting_entity_links"("meetingId", "taskId");
CREATE INDEX "meeting_entity_links_organizationId_idx" ON "meeting_entity_links"("organizationId");
CREATE INDEX "meeting_entity_links_projectId_idx" ON "meeting_entity_links"("projectId");
CREATE INDEX "meeting_entity_links_clientId_idx" ON "meeting_entity_links"("clientId");
CREATE INDEX "meeting_entity_links_channelId_idx" ON "meeting_entity_links"("channelId");
CREATE INDEX "meeting_entity_links_noteId_idx" ON "meeting_entity_links"("noteId");
CREATE INDEX "meeting_entity_links_taskId_idx" ON "meeting_entity_links"("taskId");

-- ---------------------------------------------------------------------------
-- 7. Foreign keys as Prisma models them.
-- ---------------------------------------------------------------------------
ALTER TABLE "meeting_occurrences" ADD CONSTRAINT "meeting_occurrences_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_clientContactId_fkey" FOREIGN KEY ("clientContactId") REFERENCES "client_contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "meeting_occurrence_participants_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "meeting_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "meeting_occurrence_participants_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "meeting_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "meeting_occurrence_participants_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participant_sessions" ADD CONSTRAINT "meeting_participant_sessions_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "meeting_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_participant_sessions" ADD CONSTRAINT "meeting_participant_sessions_occurrenceParticipantId_fkey" FOREIGN KEY ("occurrenceParticipantId") REFERENCES "meeting_occurrence_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_participant_sessions" ADD CONSTRAINT "meeting_participant_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_provider_events" ADD CONSTRAINT "meeting_provider_events_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "meeting_occurrences"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "meeting_entity_links_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meetings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "meeting_entity_links_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "meeting_entity_links_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "meeting_entity_links_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "meeting_entity_links_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "meeting_entity_links_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 8. Composite same-organization integrity.
-- ---------------------------------------------------------------------------
-- The single-column keys above keep their delete actions; these deferred
-- composite keys make a cross-tenant reference impossible. Columns that are
-- NULL are exempt by MATCH SIMPLE, which is what optional references want.
ALTER TABLE "meeting_occurrences" ADD CONSTRAINT "meeting_occurrences_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "meeting_occurrence_participants_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "meeting_participant_sessions" ADD CONSTRAINT "meeting_participant_sessions_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "meeting_provider_events" ADD CONSTRAINT "meeting_provider_events_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "meeting_entity_links_organizationId_id_key" UNIQUE ("organizationId", "id");

ALTER TABLE "meeting_occurrences" ADD CONSTRAINT "tenant_mtg_occurrences_meetingId_fk" FOREIGN KEY ("organizationId", "meetingId") REFERENCES "meetings" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_occurrences" ADD CONSTRAINT "tenant_mtg_occurrences_cancelledById_fk" FOREIGN KEY ("organizationId", "cancelledById") REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "meeting_participants" ADD CONSTRAINT "tenant_mtg_participants_meetingId_fk" FOREIGN KEY ("organizationId", "meetingId") REFERENCES "meetings" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "tenant_mtg_participants_userId_fk" FOREIGN KEY ("organizationId", "userId") REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_participants" ADD CONSTRAINT "tenant_mtg_participants_clientContactId_fk" FOREIGN KEY ("organizationId", "clientContactId") REFERENCES "client_contacts" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "tenant_mtg_occ_participants_occurrenceId_fk" FOREIGN KEY ("organizationId", "occurrenceId") REFERENCES "meeting_occurrences" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "tenant_mtg_occ_participants_participantId_fk" FOREIGN KEY ("organizationId", "participantId") REFERENCES "meeting_participants" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "tenant_mtg_occ_participants_userId_fk" FOREIGN KEY ("organizationId", "userId") REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "tenant_mtg_occ_participants_admittedById_fk" FOREIGN KEY ("organizationId", "admittedById") REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_occurrence_participants" ADD CONSTRAINT "tenant_mtg_occ_participants_removedById_fk" FOREIGN KEY ("organizationId", "removedById") REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "meeting_participant_sessions" ADD CONSTRAINT "tenant_mtg_sessions_occurrenceId_fk" FOREIGN KEY ("organizationId", "occurrenceId") REFERENCES "meeting_occurrences" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_participant_sessions" ADD CONSTRAINT "tenant_mtg_sessions_occurrenceParticipantId_fk" FOREIGN KEY ("organizationId", "occurrenceParticipantId") REFERENCES "meeting_occurrence_participants" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_participant_sessions" ADD CONSTRAINT "tenant_mtg_sessions_userId_fk" FOREIGN KEY ("organizationId", "userId") REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "meeting_provider_events" ADD CONSTRAINT "tenant_mtg_events_occurrenceId_fk" FOREIGN KEY ("organizationId", "occurrenceId") REFERENCES "meeting_occurrences" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "tenant_mtg_links_meetingId_fk" FOREIGN KEY ("organizationId", "meetingId") REFERENCES "meetings" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "tenant_mtg_links_projectId_fk" FOREIGN KEY ("organizationId", "projectId") REFERENCES "projects" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "tenant_mtg_links_clientId_fk" FOREIGN KEY ("organizationId", "clientId") REFERENCES "clients" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "tenant_mtg_links_channelId_fk" FOREIGN KEY ("organizationId", "channelId") REFERENCES "channels" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "tenant_mtg_links_noteId_fk" FOREIGN KEY ("organizationId", "noteId") REFERENCES "notes" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "tenant_mtg_links_taskId_fk" FOREIGN KEY ("organizationId", "taskId") REFERENCES "tasks" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "meeting_entity_links" ADD CONSTRAINT "tenant_mtg_links_createdById_fk" FOREIGN KEY ("organizationId", "createdById") REFERENCES "users" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- 9. Value constraints.
-- ---------------------------------------------------------------------------
ALTER TABLE "meeting_occurrences"
    ADD CONSTRAINT "meeting_occurrences_time_order_check" CHECK (
      "scheduledEnd" >= "scheduledStart" AND "joinClosesAt" > "joinOpensAt"
    ),
    ADD CONSTRAINT "meeting_occurrences_cancellation_check" CHECK (
      "status" <> 'CANCELLED' OR "cancelledAt" IS NOT NULL
    );

-- An invitee is exactly one of: an internal user, a client contact, or a bare
-- email address.
ALTER TABLE "meeting_participants"
    ADD CONSTRAINT "meeting_participants_identity_check" CHECK (
      num_nonnulls("userId", "clientContactId", "email") = 1
    );

-- A guest credential without an expiry is a permanent credential.
ALTER TABLE "meeting_occurrence_participants"
    ADD CONSTRAINT "meeting_occurrence_participants_guest_token_check" CHECK (
      "guestTokenHash" IS NULL OR "guestTokenExpiresAt" IS NOT NULL
    );

-- `source` only means something if WEBHOOK rows really carry provider evidence.
ALTER TABLE "meeting_participant_sessions"
    ADD CONSTRAINT "meeting_participant_sessions_source_check" CHECK (
      "source" <> 'WEBHOOK' OR "providerParticipantSid" IS NOT NULL
    ),
    ADD CONSTRAINT "meeting_participant_sessions_time_order_check" CHECK (
      "leftAt" IS NULL OR "leftAt" >= "joinedAt"
    );

ALTER TABLE "meeting_entity_links"
    ADD CONSTRAINT "meeting_entity_links_target_check" CHECK (
      num_nonnulls("projectId", "clientId", "channelId", "noteId", "taskId") = 1
    );

-- ---------------------------------------------------------------------------
-- 10. Backfill.
-- ---------------------------------------------------------------------------
-- Join window: opens 15 minutes before the scheduled start and closes 60
-- minutes after the scheduled end. Same constants the materialiser will use.

-- One occurrence per existing meeting. publicId and providerRoomName come from
-- the column defaults, so the backfill exercises exactly the generators the
-- application will.
INSERT INTO "meeting_occurrences" (
    "id", "organizationId", "meetingId", "seriesSlotStart", "scheduledStart", "scheduledEnd",
    "status", "joinOpensAt", "joinClosesAt", "createdAt", "updatedAt"
)
SELECT
    'mocc_' || replace(gen_random_uuid()::text, '-', ''),
    meeting."organizationId",
    meeting."id",
    meeting."startTime",
    meeting."startTime",
    meeting."endTime",
    CASE WHEN meeting."endTime" < CURRENT_TIMESTAMP THEN 'ENDED' ELSE 'SCHEDULED' END::"MeetingOccurrenceStatus",
    meeting."startTime" - interval '15 minutes',
    meeting."endTime" + interval '60 minutes',
    meeting."createdAt",
    CURRENT_TIMESTAMP
FROM "meetings" AS meeting;

-- Recurrence was never materialised, so the expectation is exactly one
-- occurrence per meeting. Historical attendance is nevertheless keyed by
-- occurrenceStart, and a row that names a different instant is real evidence
-- that must not be dropped: materialise that instance too, and say so.
WITH divergent AS (
    INSERT INTO "meeting_occurrences" (
        "id", "organizationId", "meetingId", "seriesSlotStart", "scheduledStart", "scheduledEnd",
        "status", "joinOpensAt", "joinClosesAt", "createdAt", "updatedAt"
    )
    SELECT DISTINCT ON (log."meetingId", log."occurrenceStart")
        'mocc_' || replace(gen_random_uuid()::text, '-', ''),
        log."organizationId",
        log."meetingId",
        log."occurrenceStart",
        log."occurrenceStart",
        log."occurrenceStart" + (meeting."endTime" - meeting."startTime"),
        'ENDED'::"MeetingOccurrenceStatus",
        log."occurrenceStart" - interval '15 minutes',
        log."occurrenceStart" + (meeting."endTime" - meeting."startTime") + interval '60 minutes',
        log."createdAt",
        CURRENT_TIMESTAMP
    FROM "meeting_attendance_log" AS log
    JOIN "meetings" AS meeting ON meeting."id" = log."meetingId"
    WHERE log."occurrenceStart" <> meeting."startTime"
    ORDER BY log."meetingId", log."occurrenceStart", log."createdAt"
    ON CONFLICT ("meetingId", "seriesSlotStart") DO NOTHING
    RETURNING 1
)
SELECT count(*) FROM divergent;

-- The watermark: every instance up to here already exists as a row.
UPDATE "meetings" AS meeting
   SET "materializedThrough" = latest."seriesSlotStart"
  FROM (
    SELECT "meetingId", max("seriesSlotStart") AS "seriesSlotStart"
      FROM "meeting_occurrences"
     GROUP BY "meetingId"
  ) AS latest
 WHERE latest."meetingId" = meeting."id";

-- Series invitees from the legacy attendee list. invitationStatus stays PENDING
-- because no RSVP was ever captured — inferring ACCEPTED would be inventing
-- consent. The series creator is recorded as HOST, which is real information.
INSERT INTO "meeting_participants" (
    "id", "organizationId", "meetingId", "userId", "displayName",
    "defaultRole", "invitationStatus", "createdAt", "updatedAt"
)
SELECT
    'mpar_' || replace(gen_random_uuid()::text, '-', ''),
    attendee."organizationId",
    attendee."meetingId",
    attendee."userId",
    person."name",
    CASE WHEN attendee."userId" = meeting."createdById" THEN 'HOST' ELSE 'ATTENDEE' END::"MeetingParticipantRole",
    'PENDING'::"MeetingInviteStatus",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "meeting_attendees" AS attendee
JOIN "meetings" AS meeting ON meeting."id" = attendee."meetingId"
JOIN "users" AS person ON person."id" = attendee."userId";

-- Legacy attendance becomes participant sessions, marked LEGACY_CLIENT with a
-- NULL provider SID so no later reader can mistake browser self-reports for
-- webhook-verified evidence.
INSERT INTO "meeting_participant_sessions" (
    "id", "organizationId", "occurrenceId", "userId", "providerParticipantSid",
    "source", "joinedAt", "leftAt", "createdAt"
)
SELECT
    'msess_' || replace(gen_random_uuid()::text, '-', ''),
    log."organizationId",
    occurrence."id",
    log."userId",
    NULL,
    'LEGACY_CLIENT'::"MeetingSessionSource",
    log."joinedAt",
    log."leftAt",
    log."createdAt"
FROM "meeting_attendance_log" AS log
JOIN "meeting_occurrences" AS occurrence
  ON occurrence."meetingId" = log."meetingId"
 AND occurrence."seriesSlotStart" = log."occurrenceStart";

-- ---------------------------------------------------------------------------
-- 11. Settle the deferred constraints, then prove the backfill lost nothing.
-- ---------------------------------------------------------------------------
-- The composite same-organization keys are DEFERRABLE INITIALLY DEFERRED, so
-- after the inserts above they are queued rather than checked. Forcing them
-- IMMEDIATE here does two jobs: it validates every backfilled row against its
-- tenant constraint while the migration can still abort, and it drains the
-- pending trigger events that would otherwise make the ALTER TABLE statements
-- in section 12 fail with "pending trigger events".
SET CONSTRAINTS ALL IMMEDIATE;

DO $$
DECLARE
  orphans bigint;
BEGIN
  SELECT count(*) INTO orphans
    FROM "meetings" AS meeting
   WHERE NOT EXISTS (
     SELECT 1 FROM "meeting_occurrences" AS occurrence WHERE occurrence."meetingId" = meeting."id"
   );
  IF orphans > 0 THEN
    RAISE EXCEPTION 'MEET-01: % meetings have no occurrence after the backfill.', orphans;
  END IF;

  SELECT count(*) INTO orphans
    FROM "meeting_attendance_log" AS log
   WHERE NOT EXISTS (
     SELECT 1 FROM "meeting_participant_sessions" AS session
      JOIN "meeting_occurrences" AS occurrence ON occurrence."id" = session."occurrenceId"
      WHERE occurrence."meetingId" = log."meetingId"
        AND occurrence."seriesSlotStart" = log."occurrenceStart"
        AND session."userId" = log."userId"
        AND session."joinedAt" = log."joinedAt"
   );
  IF orphans > 0 THEN
    RAISE EXCEPTION 'MEET-01: % attendance rows were not carried into meeting_participant_sessions.', orphans;
  END IF;

  SELECT count(*) INTO orphans
    FROM "meeting_attendees" AS attendee
   WHERE NOT EXISTS (
     SELECT 1 FROM "meeting_participants" AS participant
      WHERE participant."meetingId" = attendee."meetingId"
        AND participant."userId" = attendee."userId"
   );
  IF orphans > 0 THEN
    RAISE EXCEPTION 'MEET-01: % meeting attendees were not carried into meeting_participants.', orphans;
  END IF;

  SELECT count(*) INTO orphans
    FROM "meeting_occurrences" AS occurrence
    JOIN "meetings" AS meeting ON meeting."id" = occurrence."meetingId"
   WHERE occurrence."organizationId" <> meeting."organizationId";
  IF orphans > 0 THEN
    RAISE EXCEPTION 'MEET-01: % occurrences landed in a different organization than their meeting.', orphans;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 12. Row level security. PostgreSQL is the final tenant-isolation boundary.
-- ---------------------------------------------------------------------------
ALTER TABLE "meeting_occurrences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_occurrences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_occurrences"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "meeting_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_participants"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "meeting_occurrence_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_occurrence_participants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_occurrence_participants"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "meeting_participant_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_participant_sessions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_participant_sessions"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "meeting_provider_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_provider_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_provider_events"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "meeting_entity_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "meeting_entity_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "meeting_entity_links"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
