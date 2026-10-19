-- H1-03 — PROP-02 / PROP-03 / HK-03 inventory: room types, rooms, beds, the
-- append-only room status ledger and the OOO/OOS block ranges (05 §1.1).
--
-- Three structural decisions are made here rather than in application code,
-- because each of them is an invariant the rest of the vertical will assume:
--
--  1. **A child row can never reference another tenant's property.** Every table
--     below carries `organizationId` and joins its parent by the *pair*
--     `(organizationId, …)`, against the unique keys added for that purpose. RLS
--     is the second wall; a foreign key that cannot span tenants is the first.
--  2. **Beds exist only under a BED room type.** `hotel_rooms` carries the room
--     type's `inventoryKind` as a column that cannot drift — it is half of the
--     composite foreign key into `hotel_room_types(id, inventoryKind)` — and
--     `hotel_beds` keys into `hotel_rooms(id, inventoryKind)` with a CHECK that
--     pins its half to 'BED'. So "only BED types have beds" is arithmetic the
--     database does, not a rule a resolver has to remember (invariant 22's
--     structural half; the sales guard is a later lane's).
--  3. **Status history is append-only and block ranges cannot overlap.** The
--     first is enforced by giving `hotel_room_status_events` SELECT and INSERT
--     policies and no UPDATE or DELETE policy at all — the same shape as
--     `restaurant_order_events` — and the second by a gist exclusion constraint
--     over the room and its date range (btree_gist comes from prepare-extensions).
--
-- btree_gist is prepared by the extension step; repeating the idempotent
-- declaration keeps this migration independently legible.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- PROP-02: what a room type sells. ROOM and UNIT are sold whole; BED is sold a
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

-- Dorm policy (MODE-02). ANY is "no restriction", not "unknown".
CREATE TYPE "HotelGenderPolicy" AS ENUM ('ANY', 'MALE', 'FEMALE');

-- HK-03. Out of order is broken; out of service is deliberately withheld. Both
-- reduce availability for their range, and the distinction is what a revenue
-- report needs to tell an incident from a decision.
CREATE TYPE "HotelRoomBlockKind" AS ENUM ('OUT_OF_ORDER', 'OUT_OF_SERVICE');

-- ---------------------------------------------------------------------------
-- PROP-02 — room types
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_room_types" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  -- Bilingual where the pack shows it (05 §1.1). Urdu is optional because a
  -- property that has not translated a type yet must still be able to sell it.
  "nameUr" TEXT,
  "description" TEXT,
  "inventoryKind" "HotelInventoryKind" NOT NULL DEFAULT 'ROOM',
  "bedsPerRoom" INTEGER,
  "baseAdults" INTEGER NOT NULL DEFAULT 2,
  "maxAdults" INTEGER NOT NULL DEFAULT 2,
  "maxChildren" INTEGER NOT NULL DEFAULT 0,
  "bedConfig" TEXT,
  "amenities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "images" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- Where this type sits in the upgrade ladder. Higher is better; equal ranks
  -- are a deliberate "these are the same tier".
  "upgradeRank" INTEGER NOT NULL DEFAULT 0,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_room_types_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_types_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- A code appears on rate plans, channel mappings and imports, so it is an
  -- upper-case token rather than free text.
  CONSTRAINT "hotel_room_types_code_ck" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  CONSTRAINT "hotel_room_types_name_ck" CHECK (
    length(btrim("name")) > 0 AND ("nameUr" IS NULL OR length(btrim("nameUr")) > 0)
  ),
  -- Occupancy limits are enforced on every reservation path (PROP-02), which is
  -- only possible if they are coherent here first.
  CONSTRAINT "hotel_room_types_occupancy_ck" CHECK (
    "baseAdults" >= 1
    AND "maxAdults" >= "baseAdults"
    AND "maxAdults" <= 32
    AND "maxChildren" >= 0
    AND "maxChildren" <= 32
  ),
  -- A BED type declares its berths; a ROOM or UNIT type must not, so nothing
  -- downstream can read a bed count off inventory that has no beds.
  CONSTRAINT "hotel_room_types_beds_ck" CHECK (
    ("inventoryKind" = 'BED' AND "bedsPerRoom" BETWEEN 1 AND 64)
    OR ("inventoryKind" <> 'BED' AND "bedsPerRoom" IS NULL)
  ),
  CONSTRAINT "hotel_room_types_order_ck" CHECK ("upgradeRank" >= 0 AND "sort" >= 0)
);

CREATE UNIQUE INDEX "hotel_room_types_branch_code_key" ON "hotel_room_types"("branchId", "code");
-- Foreign-key target for `hotel_rooms`: a room's denormalized `inventoryKind` is
-- half of the key into its type, so the two can never disagree.
CREATE UNIQUE INDEX "hotel_room_types_id_kind_key" ON "hotel_room_types"("id", "inventoryKind");
CREATE UNIQUE INDEX "hotel_room_types_org_id_key" ON "hotel_room_types"("organizationId", "id");
CREATE INDEX "hotel_room_types_branch_sort_idx"
  ON "hotel_room_types"("organizationId", "branchId", "sort");

-- ---------------------------------------------------------------------------
-- PROP-03 — rooms, beds and units. One table: a unit and a dorm room are rooms
-- with a different inventory kind, not different entities.
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
  "status" "HotelRoomStatus" NOT NULL DEFAULT 'VACANT_CLEAN',
  "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusChangedBy" TEXT,
  "genderPolicy" "HotelGenderPolicy" NOT NULL DEFAULT 'ANY',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_rooms_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_rooms_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_rooms_type_fkey"
    FOREIGN KEY ("roomTypeId", "inventoryKind")
    REFERENCES "hotel_room_types"("id", "inventoryKind")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Connecting rooms are a property fact, so the link is confined to one tenant
  -- by the key itself. RESTRICT rather than SET NULL: rooms are deactivated, not
  -- deleted, and a delete that silently unlinked a neighbour would be a change to
  -- the property nobody asked for.
  CONSTRAINT "hotel_rooms_connecting_fkey"
    FOREIGN KEY ("organizationId", "connectingRoomId")
    REFERENCES "hotel_rooms"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_rooms_number_ck" CHECK (length(btrim("number")) > 0 AND length("number") <= 24),
  CONSTRAINT "hotel_rooms_connecting_self_ck" CHECK ("connectingRoomId" IS NULL OR "connectingRoomId" <> "id"),
  -- A dorm policy only means something where berths are sold separately.
  CONSTRAINT "hotel_rooms_gender_policy_ck" CHECK (
    "genderPolicy" = 'ANY' OR "inventoryKind" = 'BED'
  )
);

CREATE UNIQUE INDEX "hotel_rooms_branch_number_key" ON "hotel_rooms"("branchId", "number");
-- Foreign-key targets: `(organizationId, id)` for tenant-confined self and child
-- links, `(id, inventoryKind)` so beds can only key into a BED room.
CREATE UNIQUE INDEX "hotel_rooms_org_id_key" ON "hotel_rooms"("organizationId", "id");
CREATE UNIQUE INDEX "hotel_rooms_id_kind_key" ON "hotel_rooms"("id", "inventoryKind");
CREATE INDEX "hotel_rooms_branch_status_idx"
  ON "hotel_rooms"("organizationId", "branchId", "status");
CREATE INDEX "hotel_rooms_type_idx" ON "hotel_rooms"("organizationId", "roomTypeId");

-- ---------------------------------------------------------------------------
-- MODE-02 — beds. Only under a BED room type, and a room's occupancy is derived
-- by counting these rather than stored on the room (invariant 22).
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
  "status" "HotelRoomStatus" NOT NULL DEFAULT 'VACANT_CLEAN',
  "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "statusChangedBy" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_beds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_beds_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_beds_room_fkey"
    FOREIGN KEY ("roomId", "roomInventoryKind")
    REFERENCES "hotel_rooms"("id", "inventoryKind")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "hotel_beds_kind_ck" CHECK ("roomInventoryKind" = 'BED'),
  CONSTRAINT "hotel_beds_label_ck" CHECK (length(btrim("label")) > 0 AND length("label") <= 24)
);

CREATE UNIQUE INDEX "hotel_beds_room_label_key" ON "hotel_beds"("roomId", "label");
CREATE UNIQUE INDEX "hotel_beds_org_id_key" ON "hotel_beds"("organizationId", "id");
CREATE INDEX "hotel_beds_room_idx" ON "hotel_beds"("organizationId", "roomId");

-- ---------------------------------------------------------------------------
-- PROP-03 / HK-01 — the append-only status ledger. Every change is attributed
-- and carries the reason it was made; nothing may edit or remove a line.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_room_status_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  -- Set when the change was to one berth rather than to the whole room. The room
  -- is still named, so a dorm's history reads as one ledger.
  "bedId" TEXT,
  -- Null on the first line of a room's history, which records the state it was
  -- created in rather than a transition.
  "fromStatus" "HotelRoomStatus",
  "toStatus" "HotelRoomStatus" NOT NULL,
  -- The acting user, or a `system:` sentinel for a change an automated step
  -- makes. Never null: HK-01 is "every change attributed".
  "actorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hotel_room_status_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_status_events_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_room_status_events_room_fkey"
    FOREIGN KEY ("organizationId", "roomId")
    REFERENCES "hotel_rooms"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_room_status_events_bed_fkey"
    FOREIGN KEY ("organizationId", "bedId")
    REFERENCES "hotel_beds"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_room_status_events_actor_ck" CHECK (length(btrim("actorId")) > 0),
  CONSTRAINT "hotel_room_status_events_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "hotel_room_status_events_move_ck" CHECK ("fromStatus" IS DISTINCT FROM "toStatus")
);

CREATE INDEX "hotel_room_status_events_room_idx"
  ON "hotel_room_status_events"("organizationId", "roomId", "at" DESC);
CREATE INDEX "hotel_room_status_events_branch_idx"
  ON "hotel_room_status_events"("organizationId", "branchId", "at" DESC);

-- ---------------------------------------------------------------------------
-- HK-03 — out-of-order / out-of-service ranges. Two live blocks may not overlap
-- on one room, so availability can subtract them without deduplicating first.
-- ---------------------------------------------------------------------------
CREATE TABLE "hotel_room_blocks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "kind" "HotelRoomBlockKind" NOT NULL,
  -- Inclusive on both ends: a one-day block has startsOn = endsOn.
  "startsOn" DATE NOT NULL,
  "endsOn" DATE NOT NULL,
  "reason" TEXT NOT NULL,
  -- MNT-03 links a block to the work order that caused it. Text rather than a
  -- foreign key because work orders arrive in a later lane.
  "workOrderRef" TEXT,
  "createdBy" TEXT NOT NULL,
  -- Releasing keeps the block on the record and stops it blocking, which is what
  -- "DONE releases a linked OOO block" needs; deleting it would lose the history.
  "releasedAt" TIMESTAMP(3),
  "releasedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_room_blocks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hotel_room_blocks_property_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_room_blocks_room_fkey"
    FOREIGN KEY ("organizationId", "roomId")
    REFERENCES "hotel_rooms"("organizationId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "hotel_room_blocks_range_ck" CHECK ("endsOn" >= "startsOn"),
  CONSTRAINT "hotel_room_blocks_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "hotel_room_blocks_creator_ck" CHECK (length(btrim("createdBy")) > 0),
  CONSTRAINT "hotel_room_blocks_release_ck" CHECK (("releasedAt" IS NULL) = ("releasedBy" IS NULL)),
  -- The overlap rule itself. Partial, so a released block leaves the range free
  -- for the next one rather than blocking it forever.
  CONSTRAINT "hotel_room_blocks_no_overlap" EXCLUDE USING gist (
    "roomId" WITH =,
    daterange("startsOn", "endsOn", '[]') WITH &&
  ) WHERE ("releasedAt" IS NULL)
);

CREATE INDEX "hotel_room_blocks_room_idx"
  ON "hotel_room_blocks"("organizationId", "roomId", "startsOn");
CREATE INDEX "hotel_room_blocks_branch_idx"
  ON "hotel_room_blocks"("organizationId", "branchId", "endsOn");

-- ---------------------------------------------------------------------------
-- Tenant isolation, enabled AND forced on every table, in the migration that
-- creates them. FORCE is what makes the policy apply to the owning role too, so
-- a migration or a maintenance job is filtered like any tenant connection.
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

-- The status ledger is append-only by *policy shape*, not by convention: SELECT
-- and INSERT are granted to the tenant and there is no policy for UPDATE or
-- DELETE, so both are refused even though the runtime role holds the privilege.
-- Same construction as `restaurant_order_events` (WHA-435).
ALTER TABLE "hotel_room_status_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_room_status_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "hotel_room_status_events_tenant_select" ON "hotel_room_status_events"
  FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
CREATE POLICY "hotel_room_status_events_tenant_insert" ON "hotel_room_status_events"
  FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
