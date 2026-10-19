-- H1-03 inventory only. Existing migrations remain unchanged.
-- btree_gist is prepared by the extension owner before migration deployment.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'Prepare btree_gist with the extension owner before inventory migration';
  END IF;
END $$;
CREATE TYPE "HotelInventoryKind" AS ENUM ('ROOM', 'BED', 'UNIT');
CREATE TYPE "HotelRoomStatus" AS ENUM ('VACANT_CLEAN', 'VACANT_DIRTY', 'OCCUPIED', 'INSPECTED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE');
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
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_room_types_capacity_ck" CHECK (
    "baseAdults" >= 1 AND "maxAdults" >= "baseAdults" AND "maxChildren" >= 0 AND
    (("inventoryKind" = 'BED' AND "bedsPerRoom" BETWEEN 1 AND 100 AND "bedsPerRoom" IS NOT NULL)
    OR ("inventoryKind" <> 'BED' AND "bedsPerRoom" IS NULL))
  ),
  CONSTRAINT "hotel_room_types_text_ck" CHECK (length(btrim("code")) > 0 AND length(btrim("name")) > 0),
  CONSTRAINT "hotel_room_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_types_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "hotel_rooms" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "floor" TEXT,
  "features" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "connectingRoomId" TEXT,
  "genderPolicy" TEXT,
  "status" "HotelRoomStatus" NOT NULL DEFAULT 'VACANT_DIRTY',
  "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusChangedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_rooms_number_ck" CHECK (length(btrim("number")) > 0),
  CONSTRAINT "hotel_rooms_connecting_ck" CHECK ("connectingRoomId" IS DISTINCT FROM "id"),
  CONSTRAINT "hotel_rooms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_rooms_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "hotel_beds" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "status" "HotelRoomStatus" NOT NULL DEFAULT 'VACANT_DIRTY',
  "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusChangedBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_beds_label_ck" CHECK (length(btrim("label")) > 0),
  CONSTRAINT "hotel_beds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_beds_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "hotel_room_status_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "bedId" TEXT,
  "fromStatus" "HotelRoomStatus",
  "toStatus" "HotelRoomStatus" NOT NULL,
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_room_status_events_attribution_ck" CHECK (length(btrim("actorId")) > 0 AND length(btrim("reason")) > 0),
  CONSTRAINT "hotel_room_status_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_status_events_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "hotel_room_blocks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "kind" "HotelRoomStatus" NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "reason" TEXT NOT NULL,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  "releasedBy" TEXT,
  "releaseReason" TEXT,
  CONSTRAINT "hotel_room_blocks_range_ck" CHECK ("startDate" < "endDate"),
  CONSTRAINT "hotel_room_blocks_kind_ck" CHECK ("kind" IN ('OUT_OF_ORDER', 'OUT_OF_SERVICE')),
  CONSTRAINT "hotel_room_blocks_attribution_ck" CHECK (length(btrim("reason")) > 0 AND length(btrim("createdBy")) > 0),
  CONSTRAINT "hotel_room_blocks_release_ck" CHECK (
    ("releasedAt" IS NULL AND "releasedBy" IS NULL AND "releaseReason" IS NULL)
    OR ("releasedAt" IS NOT NULL AND "releasedBy" IS NOT NULL AND "releaseReason" IS NOT NULL
      AND length(btrim("releasedBy")) > 0 AND length(btrim("releaseReason")) > 0)
  ),
  CONSTRAINT "hotel_room_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_blocks_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE "hotel_room_status_events" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::text;
CREATE UNIQUE INDEX "hotel_room_types_scope_key" ON "hotel_room_types"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_room_types_branch_code_key" ON "hotel_room_types"("branchId", "code");
CREATE UNIQUE INDEX "hotel_rooms_scope_key" ON "hotel_rooms"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_rooms_branch_number_key" ON "hotel_rooms"("branchId", "number");
CREATE INDEX "hotel_rooms_type_idx" ON "hotel_rooms"("organizationId", "branchId", "roomTypeId");
CREATE UNIQUE INDEX "hotel_beds_scope_key" ON "hotel_beds"("organizationId", "branchId", "roomId", "id");
CREATE UNIQUE INDEX "hotel_beds_room_label_key" ON "hotel_beds"("roomId", "label");
CREATE INDEX "hotel_room_status_events_history_idx" ON "hotel_room_status_events"("organizationId", "branchId", "roomId", "createdAt");
CREATE INDEX "hotel_room_blocks_room_idx" ON "hotel_room_blocks"("organizationId", "branchId", "roomId");
ALTER TABLE "hotel_rooms" ADD CONSTRAINT "hotel_rooms_type_fkey" FOREIGN KEY ("organizationId", "branchId", "roomTypeId") REFERENCES "hotel_room_types"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_rooms" ADD CONSTRAINT "hotel_rooms_connecting_fkey" FOREIGN KEY ("organizationId", "branchId", "connectingRoomId") REFERENCES "hotel_rooms"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_beds" ADD CONSTRAINT "hotel_beds_room_fkey" FOREIGN KEY ("organizationId", "branchId", "roomId") REFERENCES "hotel_rooms"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_room_status_events" ADD CONSTRAINT "hotel_room_status_events_room_fkey" FOREIGN KEY ("organizationId", "branchId", "roomId") REFERENCES "hotel_rooms"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_room_status_events" ADD CONSTRAINT "hotel_room_status_events_bed_fkey" FOREIGN KEY ("organizationId", "branchId", "roomId", "bedId") REFERENCES "hotel_beds"("organizationId", "branchId", "roomId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_room_blocks" ADD CONSTRAINT "hotel_room_blocks_room_fkey" FOREIGN KEY ("organizationId", "branchId", "roomId") REFERENCES "hotel_rooms"("organizationId", "branchId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hotel_room_blocks" ADD CONSTRAINT "hotel_room_blocks_no_overlap" EXCLUDE USING gist
  ("roomId" WITH =, daterange("startDate", "endDate", '[)') WITH &&) WHERE ("releasedAt" IS NULL);

-- No missing-branch fallback or platform-admin bypass on inventory tables.
ALTER TABLE "hotel_room_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_room_types" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_room_types_scope" ON "hotel_room_types"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''));
ALTER TABLE "hotel_rooms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_rooms" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_rooms_scope" ON "hotel_rooms"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''));
ALTER TABLE "hotel_beds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_beds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_beds_scope" ON "hotel_beds"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''));
ALTER TABLE "hotel_room_status_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_room_status_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_room_status_events_scope" ON "hotel_room_status_events"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''));
ALTER TABLE "hotel_room_blocks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_room_blocks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_room_blocks_scope" ON "hotel_room_blocks"
  USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))
  WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''));

-- Occupied is reserved for a stay-owned transition in a later migration.
CREATE FUNCTION hotel_inventory_transition_allowed(old_status "HotelRoomStatus", new_status "HotelRoomStatus") RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT CASE old_status
  WHEN 'VACANT_DIRTY' THEN new_status IN ('VACANT_CLEAN', 'OUT_OF_ORDER', 'OUT_OF_SERVICE')
  WHEN 'VACANT_CLEAN' THEN new_status IN ('VACANT_DIRTY', 'INSPECTED', 'OUT_OF_ORDER', 'OUT_OF_SERVICE')
  WHEN 'INSPECTED' THEN new_status IN ('VACANT_DIRTY', 'OUT_OF_ORDER', 'OUT_OF_SERVICE')
  WHEN 'OUT_OF_ORDER' THEN new_status IN ('VACANT_DIRTY', 'OUT_OF_SERVICE')
  WHEN 'OUT_OF_SERVICE' THEN new_status IN ('VACANT_DIRTY', 'OUT_OF_ORDER')
  ELSE false END $$;

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

CREATE FUNCTION hotel_inventory_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' OR pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'Inventory status history is append-only and trigger-owned' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER hotel_inventory_event_guard BEFORE INSERT OR UPDATE OR DELETE ON "hotel_room_status_events" FOR EACH ROW EXECUTE FUNCTION hotel_inventory_event_guard();

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

CREATE FUNCTION hotel_inventory_block_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor text := NULLIF(btrim(current_setting('app.current_user_id', true)), '');
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Release inventory blocks instead of deleting' USING ERRCODE = '23514'; END IF;
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
COMMIT;
