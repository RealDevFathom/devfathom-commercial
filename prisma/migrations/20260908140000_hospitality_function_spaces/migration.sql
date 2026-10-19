-- H1-05 (PROP-07 · 05 §1.1, §1.7, §6 · invariant 25) — function spaces, their
-- turnaround buffers, and the booking skeleton that makes a space exclusive.
--
-- Invariant 25 is settled here, in the database, before the banquet lane exists:
-- "a function space is booked by at most one function per time slot (exclusion
-- constraint, buffers included)". An application check could not hold it — two
-- concurrent transactions both see a free slot and both commit.

-- btree_gist is a prerequisite, not this migration's to create. It is installed by
-- `prisma/prepare-extensions.ts` (prepare-extensions.sql prepares btree_gist and
-- pg_trgm) and its object ACLs are corrected by 20260830120000_btree_gist_public_
-- execute_acl. Guarding rather than re-declaring keeps ownership of the extension
-- in exactly one place: a deploy that skipped the preflight fails here, loudly,
-- instead of creating an extension owned by whoever happened to run migrations.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION
      'btree_gist is not installed. Run prisma/prepare-extensions.ts (EXTENSION_ADMIN_DATABASE_URL) before migrating; this migration does not create extensions.';
  END IF;
END $$;

-- 05 §2: a TENTATIVE event holds its functions with an expiry, a CONFIRMED one
-- has functions. Both occupy the space.
CREATE TYPE "HotelSpaceBookingKind" AS ENUM ('HOLD', 'FUNCTION');

-- The pack shapes `layouts` as `[{layout, capacity}]` and prices in PKR minor
-- units. Both are enforced by immutable helpers so a hand-written INSERT, a seed
-- or a future lane cannot put a decimal price or a capacity of zero in the column
-- and have every reader defend against it afterwards.
CREATE OR REPLACE FUNCTION "hotel_function_space_layouts_valid"(layouts jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(layouts) = 'array'
     AND jsonb_array_length(layouts) >= 1
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(layouts) AS entry
        WHERE jsonb_typeof(entry) <> 'object'
           OR jsonb_typeof(entry -> 'layout') <> 'string'
           OR btrim(entry ->> 'layout') = ''
           OR jsonb_typeof(entry -> 'capacity') <> 'number'
           OR (entry ->> 'capacity')::numeric <= 0
           OR (entry ->> 'capacity')::numeric <> trunc((entry ->> 'capacity')::numeric)
     );
$$;

CREATE OR REPLACE FUNCTION "hotel_function_space_pricing_valid"(pricing jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT jsonb_typeof(pricing) = 'object'
     AND NOT EXISTS (
       -- Money is integer minor units across the vertical. A non-numeric member
       -- (a note, a flag) is left to the writing lane; a numeric one is money.
       SELECT 1
         FROM jsonb_each(pricing) AS entry(key, value)
        WHERE jsonb_typeof(entry.value) = 'number'
          AND ((entry.value #>> '{}')::numeric < 0
               OR (entry.value #>> '{}')::numeric <> trunc((entry.value #>> '{}')::numeric))
     );
$$;

CREATE TABLE "hotel_function_spaces" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameUr" TEXT,
  -- No default: `[]` cannot satisfy the CHECK below, on purpose. A space is
  -- created with the layouts it can be set in, or not at all.
  "layouts" JSONB NOT NULL,
  "pricing" JSONB NOT NULL DEFAULT '{}',
  "setupMinutes" INTEGER NOT NULL DEFAULT 0,
  "teardownMinutes" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_function_spaces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_function_spaces_name_ck" CHECK (btrim("name") <> ''),
  CONSTRAINT "hotel_function_spaces_name_ur_ck" CHECK ("nameUr" IS NULL OR btrim("nameUr") <> ''),
  CONSTRAINT "hotel_function_spaces_layouts_ck" CHECK ("hotel_function_space_layouts_valid"("layouts")),
  CONSTRAINT "hotel_function_spaces_pricing_ck" CHECK ("hotel_function_space_pricing_valid"("pricing")),
  -- A day of turnaround is already unusual; more than that is a typo, and a typo
  -- in a buffer silently sterilises a hall's diary.
  CONSTRAINT "hotel_function_spaces_buffers_ck" CHECK (
    "setupMinutes" BETWEEN 0 AND 1440 AND "teardownMinutes" BETWEEN 0 AND 1440
  )
);

CREATE UNIQUE INDEX "hotel_function_spaces_org_id_key" ON "hotel_function_spaces"("organizationId", "id");
CREATE UNIQUE INDEX "hotel_function_spaces_org_branch_name_key" ON "hotel_function_spaces"("organizationId", "branchId", "name");
CREATE INDEX "hotel_function_spaces_org_branch_active_idx" ON "hotel_function_spaces"("organizationId", "branchId", "active");

-- Tenant-composite foreign key: the parent is matched on (organizationId, branchId)
-- so a space can never be attached to another tenant's property even if the branch
-- id were guessed.
ALTER TABLE "hotel_function_spaces"
  ADD CONSTRAINT "hotel_function_spaces_org_branch_fkey"
  FOREIGN KEY ("organizationId", "branchId")
  REFERENCES "hotel_properties"("organizationId", "branchId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "hotel_space_bookings" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "kind" "HotelSpaceBookingKind" NOT NULL,
  "ref" JSONB NOT NULL DEFAULT '{}',
  "createdBy" TEXT,
  -- Trigger-maintained (see hotel_space_booking_buffered_range below). NOT NULL
  -- matters: a GiST exclusion constraint ignores NULL ranges, so a nullable column
  -- would be a silent hole in invariant 25.
  "bufferedRange" TSTZRANGE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_space_bookings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_space_bookings_span_ck" CHECK ("endsAt" > "startsAt"),
  CONSTRAINT "hotel_space_bookings_ref_ck" CHECK (jsonb_typeof("ref") = 'object')
);

CREATE INDEX "hotel_space_bookings_org_space_start_idx" ON "hotel_space_bookings"("organizationId", "spaceId", "startsAt");
CREATE INDEX "hotel_space_bookings_org_branch_start_idx" ON "hotel_space_bookings"("organizationId", "branchId", "startsAt");

ALTER TABLE "hotel_space_bookings"
  ADD CONSTRAINT "hotel_space_bookings_org_space_fkey"
  FOREIGN KEY ("organizationId", "spaceId")
  REFERENCES "hotel_function_spaces"("organizationId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The buffered range. A generated column cannot read another table and the buffers
-- belong to the space, so the range is maintained by this BEFORE trigger and never
-- by application code. `'[)'` half-open bounds mean two bookings that merely touch
-- are not an overlap — with zero buffers, back-to-back is legal; with a buffer, the
-- widened ranges overlap and the exclusion constraint refuses the second.
CREATE OR REPLACE FUNCTION "hotel_space_booking_buffered_range"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  setup_minutes integer;
  teardown_minutes integer;
BEGIN
  SELECT "setupMinutes", "teardownMinutes"
    INTO setup_minutes, teardown_minutes
    FROM "hotel_function_spaces"
   WHERE "organizationId" = NEW."organizationId"
     AND "id" = NEW."spaceId";

  -- Unreachable through the foreign key for a tenant connection; reachable for a
  -- connection with no tenant context, where row-level security hides the space.
  -- Failing here is correct: a booking whose buffers cannot be read must not exist.
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'function space % is not visible to this connection; a space booking cannot be written without its buffers',
      NEW."spaceId";
  END IF;

  NEW."bufferedRange" := tstzrange(
    NEW."startsAt" - make_interval(mins => setup_minutes),
    NEW."endsAt" + make_interval(mins => teardown_minutes),
    '[)'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "hotel_space_bookings_buffered_range"
  BEFORE INSERT OR UPDATE OF "startsAt", "endsAt", "spaceId", "organizationId"
  ON "hotel_space_bookings"
  FOR EACH ROW
  EXECUTE FUNCTION "hotel_space_booking_buffered_range"();

-- Invariant 25. `organizationId` is carried into the key so the index is tenant-
-- ordered like every other hotel index; `spaceId` already implies the tenant
-- through the composite foreign key, so no cross-tenant collision is observable.
ALTER TABLE "hotel_space_bookings"
  ADD CONSTRAINT "hotel_space_bookings_space_no_overlap"
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "spaceId" WITH =,
    "bufferedRange" WITH &&
  );

-- Changing a space's buffers changes every one of its bookings' ranges. Without
-- this the constraint would go stale — widening setup time would leave two
-- bookings that now collide sitting happily in the table. Recomputing through an
-- UPDATE re-fires the BEFORE trigger above, so the exclusion constraint judges the
-- new buffers and refuses the change that would create an overlap.
CREATE OR REPLACE FUNCTION "hotel_function_space_rebuffer"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "hotel_space_bookings"
     SET "startsAt" = "startsAt"
   WHERE "organizationId" = NEW."organizationId"
     AND "spaceId" = NEW."id";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "hotel_function_spaces_rebuffer"
  AFTER UPDATE OF "setupMinutes", "teardownMinutes"
  ON "hotel_function_spaces"
  FOR EACH ROW
  WHEN (
    OLD."setupMinutes" IS DISTINCT FROM NEW."setupMinutes"
    OR OLD."teardownMinutes" IS DISTINCT FROM NEW."teardownMinutes"
  )
  EXECUTE FUNCTION "hotel_function_space_rebuffer"();

-- Tenant isolation is the database's job and is forced for the table owner too,
-- so a migration or a job running as the owner cannot read across tenants either.
ALTER TABLE "hotel_function_spaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_function_spaces" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hotel_function_spaces_tenant_isolation" ON "hotel_function_spaces"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "hotel_space_bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_space_bookings" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hotel_space_bookings_tenant_isolation" ON "hotel_space_bookings"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
