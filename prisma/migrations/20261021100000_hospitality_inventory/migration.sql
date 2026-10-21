-- H1-03 — PROP-02 / PROP-03 / HK-01 / HK-03 / MODE-02 inventory: room types,
-- rooms, beds, the append-only room status ledger and the out-of-order /
-- out-of-service block ranges. Additive only; nothing existing is altered.
--
-- Four structural decisions are made here rather than in application code,
-- because each is an invariant the rest of the vertical will assume:
--
--  1. **A child row can never reference another tenant's property.** Every
--     table carries `organizationId` and joins its parent by the composite
--     `(organizationId, branchId, …)` against the unique keys added for that
--     purpose. Row-level security is the second wall; a foreign key that cannot
--     span tenants or properties is the first. There is no foreign key to
--     `organizations`: `hotel_properties` is the tenant anchor.
--  2. **Beds exist only under a BED room type.** `hotel_rooms` carries its
--     type's `inventoryKind` as a column that cannot drift — it is half of a
--     composite foreign key into `hotel_room_types(id, inventoryKind)` — and
--     `hotel_beds` keys into `hotel_rooms(id, inventoryKind)` with a CHECK that
--     pins its half to 'BED'. The structure guard below adds the capacity lock.
--  3. **Status history is trigger-owned and append-only.** Every status change
--     on a room or a bed writes its own ledger line from inside the database,
--     attributed to `app.current_user_id` with the reason in
--     `app.hotel_inventory_reason`; a direct insert, an update or a delete of a
--     ledger line is refused. The one exception is the sanctioned tenant purge,
--     which names the organization in `app.purging_organization_id` exactly as
--     the pharmacy onboarding ledger and camera evidence already accept.
--  4. **Live block ranges cannot overlap.** A gist exclusion over the room and
--     its half-open `[startDate, endDate)` range, partial on unreleased rows, so
--     availability can subtract blocks without deduplicating first. Blocks are
--     released, never deleted (the purge exemption applies here too).
--
-- `OCCUPIED` is a stay-owned state: nothing here can enter or leave it. The
-- transition function reserves it for the front-desk lane's own migration.
--
-- btree_gist is prepared by the extension owner before `migrate deploy`
-- (`prisma/prepare-extensions.sql`); the guard below only makes a missing
-- preparation fail legibly instead of on the exclusion constraint.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'Prepare btree_gist with the extension owner before deploying the hospitality inventory migration';
  END IF;
END $$;

-- PROP-02: what a type sells. ROOM and UNIT are sold whole; BED is sold one
-- berth at a time and declares how many berths a room of that type holds.
CREATE TYPE "HotelInventoryKind" AS ENUM ('ROOM', 'BED', 'UNIT');

-- PROP-03's six states, exactly as the PRD lists them.
CREATE TYPE "HotelRoomStatus" AS ENUM (
  'VACANT_CLEAN',
  'VACANT_DIRTY',
  'OCCUPIED',
  'INSPECTED',
  'OUT_OF_ORDER',
  'OUT_OF_SERVICE'
);

-- HK-03. Out of order is broken; out of service is deliberately withheld. Both
-- reduce availability; the distinction tells an incident from a decision.
CREATE TYPE "HotelRoomBlockKind" AS ENUM ('OUT_OF_ORDER', 'OUT_OF_SERVICE');

-- MODE-02 dorm policy. ANY is "no restriction", not "not yet decided".
CREATE TYPE "HotelGenderPolicy" AS ENUM ('ANY', 'MALE', 'FEMALE');

-- ---------------------------------------------------------------------------
-- PROP-02 — room types
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_room_types" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameUr" TEXT,
  "inventoryKind" "HotelInventoryKind" NOT NULL DEFAULT 'ROOM',
  "bedsPerRoom" INTEGER,
  "description" TEXT,
  "baseAdults" INTEGER NOT NULL DEFAULT 1,
  "maxAdults" INTEGER NOT NULL DEFAULT 2,
  "maxChildren" INTEGER NOT NULL DEFAULT 0,
  "bedConfig" TEXT,
  "amenities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "images" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "upgradeRank" INTEGER NOT NULL DEFAULT 0,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_room_types_pkey" PRIMARY KEY ("id"),
  -- A code travels to rate plans, channel mappings and imports: a token, not a
  -- sentence, in the same shape as `hotel_extras.code`.
  CONSTRAINT "hotel_room_types_code_ck" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  CONSTRAINT "hotel_room_types_text_ck" CHECK (
    length(btrim("name")) > 0 AND ("nameUr" IS NULL OR length(btrim("nameUr")) > 0)
  ),
  -- Occupancy limits are enforced on every reservation path (PROP-02), which is
  -- only possible if they are coherent here first. A BED type declares its
  -- berths; a ROOM or UNIT type must not, so nothing downstream can read a bed
  -- count off inventory that has no beds.
  CONSTRAINT "hotel_room_types_capacity_ck" CHECK (
    "baseAdults" >= 1 AND "maxAdults" >= "baseAdults" AND "maxChildren" >= 0
    AND (
      ("inventoryKind" = 'BED' AND "bedsPerRoom" BETWEEN 1 AND 100)
      OR ("inventoryKind" <> 'BED' AND "bedsPerRoom" IS NULL)
    )
  ),
  CONSTRAINT "hotel_room_types_order_ck" CHECK ("upgradeRank" >= 0 AND "sort" >= 0),
  CONSTRAINT "hotel_room_types_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "hotel_room_types_scope_key" ON "hotel_room_types"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_room_types_org_branch_code_key" ON "hotel_room_types"("organizationId", "branchId", "code");
-- Foreign-key target for `hotel_rooms`: a room's denormalized `inventoryKind`
-- is half of the key into its type, so the two can never disagree.
CREATE UNIQUE INDEX "hotel_room_types_id_kind_key" ON "hotel_room_types"("id", "inventoryKind");

-- ---------------------------------------------------------------------------
-- PROP-03 — rooms, dorm rooms and units. One table: a unit and a dorm room are
-- rooms with a different inventory kind, not different entities.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_rooms" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  -- Denormalized from the type and held there by the composite foreign key
  -- below. Never written independently of the type.
  "inventoryKind" "HotelInventoryKind" NOT NULL,
  "number" TEXT NOT NULL,
  "floor" TEXT,
  "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "connectingRoomId" TEXT,
  "genderPolicy" "HotelGenderPolicy" NOT NULL DEFAULT 'ANY',
  -- A room is commissioned dirty: nothing is sellable until housekeeping says so.
  "status" "HotelRoomStatus" NOT NULL DEFAULT 'VACANT_DIRTY',
  "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusChangedBy" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_rooms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_rooms_number_ck" CHECK (length(btrim("number")) > 0),
  CONSTRAINT "hotel_rooms_connecting_ck" CHECK ("connectingRoomId" IS DISTINCT FROM "id"),
  -- A dorm policy only means something where berths are sold separately.
  CONSTRAINT "hotel_rooms_gender_policy_ck" CHECK ("genderPolicy" = 'ANY' OR "inventoryKind" = 'BED'),
  CONSTRAINT "hotel_rooms_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "hotel_rooms_scope_key" ON "hotel_rooms"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_rooms_org_branch_number_key" ON "hotel_rooms"("organizationId", "branchId", "number");
-- Foreign-key target for `hotel_beds`: a bed can only key into a BED room.
CREATE UNIQUE INDEX "hotel_rooms_id_kind_key" ON "hotel_rooms"("id", "inventoryKind");
CREATE INDEX "hotel_rooms_type_idx" ON "hotel_rooms"("organizationId", "branchId", "roomTypeId");
CREATE INDEX "hotel_rooms_branch_status_idx" ON "hotel_rooms"("organizationId", "branchId", "status");

-- ---------------------------------------------------------------------------
-- MODE-02 — beds. Only under a BED room type, and a room's occupancy is
-- derived by counting these rather than stored on the room (invariant 22).
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_beds" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  -- Pinned to 'BED' by the CHECK and to the room's own kind by the foreign key.
  -- Together they are the statement "a bed belongs to a BED room, always".
  "roomInventoryKind" "HotelInventoryKind" NOT NULL DEFAULT 'BED',
  "label" TEXT NOT NULL,
  "status" "HotelRoomStatus" NOT NULL DEFAULT 'VACANT_DIRTY',
  "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusChangedBy" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_beds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_beds_label_ck" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "hotel_beds_kind_ck" CHECK ("roomInventoryKind" = 'BED'),
  CONSTRAINT "hotel_beds_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "hotel_beds_scope_key" ON "hotel_beds"("organizationId", "branchId", "roomId", "id");
CREATE UNIQUE INDEX "hotel_beds_room_label_key" ON "hotel_beds"("roomId", "label");

-- ---------------------------------------------------------------------------
-- PROP-03 / HK-01 — the append-only status ledger. Written only by the status
-- triggers below; `id` therefore has a database default.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_room_status_events" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  -- Set when the change was to one berth rather than to the whole room. The
  -- room is still named, so a dorm's history reads as one ledger.
  "bedId" TEXT,
  -- Null on the first line of a room's history, which records the state it
  -- was created in rather than a transition.
  "fromStatus" "HotelRoomStatus",
  "toStatus" "HotelRoomStatus" NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_room_status_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_status_events_attribution_ck" CHECK (
    length(btrim("actorId")) > 0 AND length(btrim("reason")) > 0
  ),
  CONSTRAINT "hotel_room_status_events_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "hotel_room_status_events_history_idx"
  ON "hotel_room_status_events"("organizationId", "branchId", "roomId", "createdAt");

-- ---------------------------------------------------------------------------
-- HK-03 — out-of-order / out-of-service ranges, half-open [startDate, endDate).
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_room_blocks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "kind" "HotelRoomBlockKind" NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "reason" TEXT NOT NULL,
  -- MNT-03 links a block to the work order that caused it. Text rather than a
  -- foreign key because work orders arrive in a later lane.
  "workOrderRef" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Releasing keeps the block on the record and stops it blocking; deleting it
  -- would lose the history of why a room was withheld.
  "releasedAt" TIMESTAMP(3),
  "releasedBy" TEXT,
  "releaseReason" TEXT,
  CONSTRAINT "hotel_room_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_blocks_range_ck" CHECK ("startDate" < "endDate"),
  CONSTRAINT "hotel_room_blocks_attribution_ck" CHECK (
    length(btrim("reason")) > 0 AND length(btrim("createdBy")) > 0
  ),
  CONSTRAINT "hotel_room_blocks_release_ck" CHECK (
    ("releasedAt" IS NULL AND "releasedBy" IS NULL AND "releaseReason" IS NULL)
    OR (
      "releasedAt" IS NOT NULL AND "releasedBy" IS NOT NULL AND "releaseReason" IS NOT NULL
      AND length(btrim("releasedBy")) > 0 AND length(btrim("releaseReason")) > 0
    )
  ),
  CONSTRAINT "hotel_room_blocks_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "hotel_room_blocks_room_idx" ON "hotel_room_blocks"("organizationId", "branchId", "roomId");

-- ---------------------------------------------------------------------------
-- Composite foreign keys between the inventory tables. Every one carries the
-- organization and the property, so a crafted id from another tenant or
-- another property finds nothing even before RLS is consulted. The two
-- `(id, inventoryKind)` keys are the structural "beds only under BED" rule.
-- ---------------------------------------------------------------------------
ALTER TABLE "hotel_rooms" ADD CONSTRAINT "hotel_rooms_type_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomTypeId")
  REFERENCES "hotel_room_types"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_rooms" ADD CONSTRAINT "hotel_rooms_type_kind_fkey"
  FOREIGN KEY ("roomTypeId", "inventoryKind")
  REFERENCES "hotel_room_types"("id", "inventoryKind")
  ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT rather than SET NULL: rooms are deactivated, not deleted, and a
-- delete that silently unlinked a neighbour would be a change nobody asked for.
ALTER TABLE "hotel_rooms" ADD CONSTRAINT "hotel_rooms_connecting_fkey"
  FOREIGN KEY ("organizationId", "branchId", "connectingRoomId")
  REFERENCES "hotel_rooms"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_beds" ADD CONSTRAINT "hotel_beds_room_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomId")
  REFERENCES "hotel_rooms"("organizationId", "branchId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hotel_beds" ADD CONSTRAINT "hotel_beds_room_kind_fkey"
  FOREIGN KEY ("roomId", "roomInventoryKind")
  REFERENCES "hotel_rooms"("id", "inventoryKind")
  ON DELETE CASCADE ON UPDATE CASCADE;
-- CASCADE so the purge's per-table deletes and a room's own removal both reach
-- the ledger; the event guard below still refuses every delete that is not
-- the sanctioned purge.
ALTER TABLE "hotel_room_status_events" ADD CONSTRAINT "hotel_room_status_events_room_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomId")
  REFERENCES "hotel_rooms"("organizationId", "branchId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hotel_room_status_events" ADD CONSTRAINT "hotel_room_status_events_bed_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomId", "bedId")
  REFERENCES "hotel_beds"("organizationId", "branchId", "roomId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hotel_room_blocks" ADD CONSTRAINT "hotel_room_blocks_room_fkey"
  FOREIGN KEY ("organizationId", "branchId", "roomId")
  REFERENCES "hotel_rooms"("organizationId", "branchId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- The overlap rule itself (invariant: two live blocks never overlap on one
-- room). Partial, so a released block frees its range for the next one.
ALTER TABLE "hotel_room_blocks" ADD CONSTRAINT "hotel_room_blocks_no_overlap"
  EXCLUDE USING gist ("roomId" WITH =, daterange("startDate", "endDate", '[)') WITH &&)
  WHERE ("releasedAt" IS NULL);

-- ---------------------------------------------------------------------------
-- Tenant isolation, enabled AND forced on every table, in the migration that
-- creates them. The standard shape: the control plane or the row's own
-- organization. The ledger keeps the same shape — append-only is a trigger
-- rule below, so the sanctioned purge (platform scope, named organization)
-- can still empty it.
-- ---------------------------------------------------------------------------
ALTER TABLE "hotel_room_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_room_types" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_room_types_tenant_isolation" ON "hotel_room_types"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "hotel_rooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_rooms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_rooms_tenant_isolation" ON "hotel_rooms"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "hotel_beds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_beds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_beds_tenant_isolation" ON "hotel_beds"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "hotel_room_status_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_room_status_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_room_status_events_tenant_isolation" ON "hotel_room_status_events"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

ALTER TABLE "hotel_room_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_room_blocks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_room_blocks_tenant_isolation" ON "hotel_room_blocks"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

-- ---------------------------------------------------------------------------
-- PROP-03's transition matrix, as the database enforces it. Cleaning runs
-- VACANT_DIRTY -> VACANT_CLEAN -> INSPECTED and a failed inspection goes back
-- to dirty; anything vacant may be withheld and the two withheld states may be
-- corrected into each other; a room coming back from either lands on dirty,
-- because a room that has had work done in it is cleaned before it is sold.
-- OCCUPIED is reserved for a stay-owned transition in a later migration, so it
-- is neither a source nor a target here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hotel_inventory_transition_allowed(old_status "HotelRoomStatus", new_status "HotelRoomStatus") RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT CASE old_status
  WHEN 'VACANT_DIRTY' THEN new_status IN ('VACANT_CLEAN', 'OUT_OF_ORDER', 'OUT_OF_SERVICE')
  WHEN 'VACANT_CLEAN' THEN new_status IN ('VACANT_DIRTY', 'INSPECTED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE')
  WHEN 'INSPECTED' THEN new_status IN ('VACANT_DIRTY', 'OUT_OF_ORDER', 'OUT_OF_SERVICE')
  WHEN 'OUT_OF_ORDER' THEN new_status IN ('VACANT_DIRTY', 'OUT_OF_SERVICE')
  WHEN 'OUT_OF_SERVICE' THEN new_status IN ('VACANT_DIRTY', 'OUT_OF_ORDER')
  ELSE false END $$;

-- HK-01: every status change is attributed and carries its reason. The actor
-- is the request's `app.current_user_id`, never a column the caller may set,
-- and the reason travels in `app.hotel_inventory_reason` for the one
-- transaction that makes the change. Identity columns are immutable.
CREATE FUNCTION hotel_inventory_status_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text := NULLIF(btrim(current_setting('app.current_user_id', true)), '');
        reason text := NULLIF(btrim(current_setting('app.hotel_inventory_reason', true)), '');
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."id", NEW."organizationId", NEW."branchId") IS DISTINCT FROM (OLD."id", OLD."organizationId", OLD."branchId") THEN
    RAISE EXCEPTION 'Inventory identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF actor IS NULL OR reason IS NULL THEN RAISE EXCEPTION 'Inventory status requires actor and reason' USING ERRCODE = '23514'; END IF;
    IF (TG_OP = 'INSERT' AND NEW."status" <> 'VACANT_DIRTY') OR
       (TG_OP = 'UPDATE' AND NOT hotel_inventory_transition_allowed(OLD."status", NEW."status")) THEN
      RAISE EXCEPTION 'Invalid inventory status transition' USING ERRCODE = '23514';
    END IF;
    NEW."statusChangedAt" := clock_timestamp();
    NEW."statusChangedBy" := actor;
  ELSE
    NEW."statusChangedAt" := OLD."statusChangedAt";
    NEW."statusChangedBy" := OLD."statusChangedBy";
  END IF;
  RETURN NEW;
END $$;

-- The ledger line, written by the database itself for every status change.
CREATE FUNCTION hotel_inventory_status_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW."status" IS DISTINCT FROM OLD."status" THEN
    INSERT INTO "hotel_room_status_events" ("organizationId", "branchId", "roomId", "bedId", "fromStatus", "toStatus", "actorId", "reason", "createdAt")
    VALUES (NEW."organizationId", NEW."branchId",
      CASE WHEN TG_TABLE_NAME = 'hotel_rooms' THEN NEW."id" ELSE to_jsonb(NEW)->>'roomId' END,
      CASE WHEN TG_TABLE_NAME = 'hotel_beds' THEN NEW."id" ELSE NULL END,
      CASE WHEN TG_OP = 'UPDATE' THEN OLD."status" ELSE NULL END, NEW."status", NEW."statusChangedBy",
      btrim(current_setting('app.hotel_inventory_reason', true)), NEW."statusChangedAt");
  END IF;
  RETURN NEW;
END $$;

-- Append-only and trigger-owned: a line is inserted only from inside a status
-- trigger (trigger depth 2), and never updated. A delete is admitted only for
-- the sanctioned tenant purge, which names the organization it is destroying.
CREATE FUNCTION hotel_inventory_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Inventory status history is append-only and trigger-owned' USING ERRCODE = '23514';
  END IF;
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Inventory status history is append-only and trigger-owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_inventory_event_guard BEFORE INSERT OR UPDATE OR DELETE ON "hotel_room_status_events" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_event_guard();

-- Structure: a type's kind and capacity never change once rooms may depend on
-- them, a room never moves between types, a bed never moves between rooms, and
-- a BED room never holds more berths than its type declares. The capacity
-- count is taken under the room's own lock, so two concurrent bed inserts are
-- serialized rather than both passing the count.
CREATE FUNCTION hotel_inventory_structure_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind "HotelInventoryKind"; capacity integer; bed_count integer;
BEGIN
  IF TG_TABLE_NAME = 'hotel_room_types' THEN
    IF (NEW."id", NEW."organizationId", NEW."branchId", NEW."inventoryKind", NEW."bedsPerRoom") IS DISTINCT FROM
       (OLD."id", OLD."organizationId", OLD."branchId", OLD."inventoryKind", OLD."bedsPerRoom") THEN
      RAISE EXCEPTION 'Inventory type identity and capacity cannot change' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'hotel_rooms' THEN
    IF TG_OP = 'UPDATE' AND NEW."roomTypeId" IS DISTINCT FROM OLD."roomTypeId" THEN
      RAISE EXCEPTION 'Room type cannot change' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' AND NEW."roomId" IS DISTINCT FROM OLD."roomId" THEN
      RAISE EXCEPTION 'Bed room cannot change' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' THEN
      -- Serialize bed insertion for this room before counting, including direct SQL writers.
      PERFORM 1 FROM "hotel_rooms" WHERE "organizationId" = NEW."organizationId" AND "branchId" = NEW."branchId" AND "id" = NEW."roomId" FOR UPDATE;
      SELECT t."inventoryKind", t."bedsPerRoom" INTO kind, capacity FROM "hotel_rooms" r JOIN "hotel_room_types" t
        ON (t."organizationId", t."branchId", t."id") = (r."organizationId", r."branchId", r."roomTypeId")
        WHERE r."organizationId" = NEW."organizationId" AND r."branchId" = NEW."branchId" AND r."id" = NEW."roomId";
      SELECT count(*) INTO bed_count FROM "hotel_beds" WHERE "roomId" = NEW."roomId";
      IF kind IS DISTINCT FROM 'BED' OR bed_count >= capacity THEN
        RAISE EXCEPTION 'Bed requires BED inventory with spare capacity' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_room_types_structure_guard BEFORE UPDATE ON "hotel_room_types" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_structure_guard();
CREATE TRIGGER hotel_rooms_structure_guard BEFORE INSERT OR UPDATE ON "hotel_rooms" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_structure_guard();
CREATE TRIGGER hotel_beds_structure_guard BEFORE INSERT OR UPDATE ON "hotel_beds" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_structure_guard();
CREATE TRIGGER hotel_rooms_status_guard BEFORE INSERT OR UPDATE ON "hotel_rooms" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_status_guard();
CREATE TRIGGER hotel_rooms_status_event AFTER INSERT OR UPDATE ON "hotel_rooms" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_status_event();
CREATE TRIGGER hotel_beds_status_guard BEFORE INSERT OR UPDATE ON "hotel_beds" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_status_guard();
CREATE TRIGGER hotel_beds_status_event AFTER INSERT OR UPDATE ON "hotel_beds" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_status_event();

-- HK-03: a block is created attributed and unreleased, changed exactly once
-- (its release, attributed to whoever releases it) and never deleted — except
-- by the sanctioned tenant purge, which names the organization it destroys.
CREATE FUNCTION hotel_inventory_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text := NULLIF(btrim(current_setting('app.current_user_id', true)), '');
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Release inventory blocks instead of deleting' USING ERRCODE = '23514';
  END IF;
  IF actor IS NULL THEN RAISE EXCEPTION 'Inventory block requires actor' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."releasedAt" IS NOT NULL THEN RAISE EXCEPTION 'New block cannot be released' USING ERRCODE = '23514'; END IF;
    NEW."createdBy" := actor;
    NEW."createdAt" := clock_timestamp();
  ELSE
    IF (to_jsonb(NEW) - ARRAY['releasedAt','releasedBy','releaseReason']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['releasedAt','releasedBy','releaseReason']) OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL THEN
      RAISE EXCEPTION 'Inventory blocks allow only one attributed release' USING ERRCODE = '23514';
    END IF;
    NEW."releasedBy" := actor;
    NEW."releasedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_inventory_block_guard BEFORE INSERT OR UPDATE OR DELETE ON "hotel_room_blocks" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_block_guard();
