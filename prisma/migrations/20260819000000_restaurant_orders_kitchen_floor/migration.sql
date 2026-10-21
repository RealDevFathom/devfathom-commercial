-- M4-L1 — Orders, kitchen (KOT/KDS), floor & service sections/stations, the
-- append-only order event ledger + transactional outbox, device idempotency,
-- and per-branch business-day order numbering for the Restaurant vertical
-- (restaurant/m4).
--
-- Additive and org-scoped. Every new table carries a bare, RLS-guarded
-- organizationId (defaulting from the transaction-local setting so an INSERT
-- cannot omit or forge it) and gets forced org-level RLS with the exact clause
-- used by 20260728092000_row_level_security / M1-L1 / M2-L1 / M3-L1 (including
-- the app.is_platform_admin control-plane escape). Cross-tenant-safe composite
-- foreign keys (matching the M1/M2/M3 precedent) make a cross-organization
-- reference impossible even inside the platform scope.
--
-- Binding design constraints realised here:
--   C1  Forced org RLS on ALL 17 new tables.
--   C2  Ledger-first: the append-only restaurant_order_events (per-order monotone
--       sequence, unique (orderId, sequence)) and the transactional
--       restaurant_event_outbox (PENDING/DISPATCHED/DEAD + attempt fields) are the
--       durable substrate the KOT/KDS read models derive from. The dispatcher is a
--       seam; no external consumer ships in M4.
--   C3  Single-authority state machines: RestaurantOrderStatus /
--       RestaurantOrderItemStatus are the EXACT §11.1 enums. There is NO stored
--       aggregate/total column on restaurant_orders — order aggregates are derived.
--   C4  Snapshot-on-write: restaurant_order_items freezes name, unitPrice,
--       quantity, and zero-valued tax/service-charge Decimals; modifiers snapshot
--       name + price delta. All money is DECIMAL; no floating point.
--   C5  Business date is a DATE stamped explicitly; the human order number is
--       allocated from a per-(branch, businessDate) sequence row (unique
--       (branchId, businessDate)); uniqueness + monotonicity guaranteed, gap-free
--       NOT promised.
--   C6  Attribution columns (opening operator + terminal, event actor) record who
--       and which device; server time is authoritative. Post-preparation void
--       records a wastage disposition (WASTE|RESTOCK|NONE) with NO stock mutation.
--   C7  Device-scoped idempotency keys, unique (deviceId, key).
--
-- The CREATE TABLE / index / single-column FK section below is the exact output
-- of `prisma migrate diff` for these models; the two additive columns and the
-- security section that follows are hand-authored because they use
-- migration-only constructs (deferred composite tenant FKs, (organizationId, id)
-- uniques, a partial unique index, a CHECK, forced RLS) that Prisma cannot
-- express, so an auto-generated diff would try to DROP them as phantom drift.

-- CreateEnum
CREATE TYPE "RestaurantOrderStatus" AS ENUM ('DRAFT', 'OPEN', 'SENT', 'IN_PREPARATION', 'READY', 'SERVED', 'PAYMENT_PENDING', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RestaurantOrderItemStatus" AS ENUM ('HELD', 'QUEUED', 'FIRING', 'PREPARED', 'SERVED', 'REMAKE_REQUESTED', 'VOIDED');

-- CreateEnum
CREATE TYPE "RestaurantWastageDisposition" AS ENUM ('WASTE', 'RESTOCK', 'NONE');

-- CreateEnum
CREATE TYPE "RestaurantOrderTableLinkReason" AS ENUM ('SEATED', 'MOVE', 'MERGE');

-- CreateEnum
CREATE TYPE "RestaurantOutboxStatus" AS ENUM ('PENDING', 'DISPATCHED', 'DEAD');

-- CreateEnum
CREATE TYPE "RestaurantDeviceKind" AS ENUM ('POS', 'KDS');

-- ---------------------------------------------------------------------------
-- Additive columns on existing tables (the only DDL touching non-M4 tables):
--   restaurant_branches.businessDayCutoff — branch-local wall-clock cutoff (C5).
--   restaurant_registered_devices.kind / stationId — POS vs KDS + station bind (C8).
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "restaurant_branches" ADD COLUMN     "businessDayCutoff" TEXT NOT NULL DEFAULT '00:00';

-- AlterTable
ALTER TABLE "restaurant_registered_devices" ADD COLUMN     "kind" "RestaurantDeviceKind" NOT NULL DEFAULT 'POS',
ADD COLUMN     "stationId" TEXT;

-- CreateTable
CREATE TABLE "restaurant_floors" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_floors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_tables" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "floorId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_server_sections" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_server_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_server_section_tables" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "sectionId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_server_section_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_server_section_assignments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "sectionId" TEXT NOT NULL,
    "staffProfileId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_server_section_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_kitchen_stations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_kitchen_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_station_routing_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "stationId" TEXT NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_station_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "businessDate" DATE NOT NULL,
    "status" "RestaurantOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "channel" "RestaurantOrderChannel" NOT NULL,
    "coverCount" INTEGER,
    "sectionId" TEXT,
    "serverStaffProfileId" TEXT,
    "staffProfileId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "publicationId" TEXT,
    "priceListVersionId" TEXT,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "orderId" TEXT NOT NULL,
    "course" INTEGER NOT NULL DEFAULT 1,
    "seatNumber" INTEGER,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "name" TEXT NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "serviceChargeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" "RestaurantOrderItemStatus" NOT NULL DEFAULT 'HELD',
    "remakeOfItemId" TEXT,
    "voidedPostPrep" BOOLEAN NOT NULL DEFAULT false,
    "wastageDisposition" "RestaurantWastageDisposition",
    "voidCoAuthorizationId" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order_item_modifiers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "orderItemId" TEXT NOT NULL,
    "modifierOptionId" TEXT,
    "name" TEXT NOT NULL,
    "priceDelta" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_order_item_modifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order_tables" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "orderId" TEXT NOT NULL,
    "tableId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "linkReason" "RestaurantOrderTableLinkReason" NOT NULL DEFAULT 'SEATED',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_order_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order_events" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "orderId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorStaffProfileId" TEXT,
    "actorDeviceId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_event_outbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "RestaurantOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order_idempotency_keys" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "deviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "resultRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_order_idempotency_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_kitchen_tickets" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "orderId" TEXT NOT NULL,
    "stationId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "ticketNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_kitchen_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_kitchen_ticket_items" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "ticketId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_kitchen_ticket_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_order_number_sequences" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
    "branchId" TEXT NOT NULL,
    "businessDate" DATE NOT NULL,
    "nextNumber" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_order_number_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_floors_organizationId_idx" ON "restaurant_floors"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_floors_branchId_idx" ON "restaurant_floors"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_tables_organizationId_idx" ON "restaurant_tables"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_tables_floorId_idx" ON "restaurant_tables"("floorId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_tables_floorId_code_key" ON "restaurant_tables"("floorId", "code");

-- CreateIndex
CREATE INDEX "restaurant_server_sections_organizationId_idx" ON "restaurant_server_sections"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_server_sections_branchId_idx" ON "restaurant_server_sections"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_server_section_tables_organizationId_idx" ON "restaurant_server_section_tables"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_server_section_tables_sectionId_idx" ON "restaurant_server_section_tables"("sectionId");

-- CreateIndex
CREATE INDEX "restaurant_server_section_tables_tableId_idx" ON "restaurant_server_section_tables"("tableId");

-- CreateIndex
CREATE INDEX "restaurant_server_section_assignments_organizationId_idx" ON "restaurant_server_section_assignments"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_server_section_assignments_sectionId_idx" ON "restaurant_server_section_assignments"("sectionId");

-- CreateIndex
CREATE INDEX "restaurant_server_section_assignments_staffProfileId_idx" ON "restaurant_server_section_assignments"("staffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_server_section_assignments_businessDate_idx" ON "restaurant_server_section_assignments"("businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_server_section_assignments_sectionId_staffProfil_key" ON "restaurant_server_section_assignments"("sectionId", "staffProfileId", "businessDate");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_stations_organizationId_idx" ON "restaurant_kitchen_stations"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_stations_branchId_idx" ON "restaurant_kitchen_stations"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_station_routing_rules_organizationId_idx" ON "restaurant_station_routing_rules"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_station_routing_rules_stationId_idx" ON "restaurant_station_routing_rules"("stationId");

-- CreateIndex
CREATE INDEX "restaurant_station_routing_rules_productId_idx" ON "restaurant_station_routing_rules"("productId");

-- CreateIndex
CREATE INDEX "restaurant_station_routing_rules_categoryId_idx" ON "restaurant_station_routing_rules"("categoryId");

-- CreateIndex
CREATE INDEX "restaurant_orders_organizationId_idx" ON "restaurant_orders"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_orders_branchId_idx" ON "restaurant_orders"("branchId");

-- CreateIndex
CREATE INDEX "restaurant_orders_status_idx" ON "restaurant_orders"("status");

-- CreateIndex
CREATE INDEX "restaurant_orders_businessDate_idx" ON "restaurant_orders"("businessDate");

-- CreateIndex
CREATE INDEX "restaurant_orders_sectionId_idx" ON "restaurant_orders"("sectionId");

-- CreateIndex
CREATE INDEX "restaurant_orders_serverStaffProfileId_idx" ON "restaurant_orders"("serverStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_orders_staffProfileId_idx" ON "restaurant_orders"("staffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_orders_deviceId_idx" ON "restaurant_orders"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_orders_branchId_businessDate_orderNumber_key" ON "restaurant_orders"("branchId", "businessDate", "orderNumber");

-- CreateIndex
CREATE INDEX "restaurant_order_items_organizationId_idx" ON "restaurant_order_items"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_order_items_orderId_idx" ON "restaurant_order_items"("orderId");

-- CreateIndex
CREATE INDEX "restaurant_order_items_productId_idx" ON "restaurant_order_items"("productId");

-- CreateIndex
CREATE INDEX "restaurant_order_items_variantId_idx" ON "restaurant_order_items"("variantId");

-- CreateIndex
CREATE INDEX "restaurant_order_items_status_idx" ON "restaurant_order_items"("status");

-- CreateIndex
CREATE INDEX "restaurant_order_items_remakeOfItemId_idx" ON "restaurant_order_items"("remakeOfItemId");

-- CreateIndex
CREATE INDEX "restaurant_order_item_modifiers_organizationId_idx" ON "restaurant_order_item_modifiers"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_order_item_modifiers_orderItemId_idx" ON "restaurant_order_item_modifiers"("orderItemId");

-- CreateIndex
CREATE INDEX "restaurant_order_item_modifiers_modifierOptionId_idx" ON "restaurant_order_item_modifiers"("modifierOptionId");

-- CreateIndex
CREATE INDEX "restaurant_order_tables_organizationId_idx" ON "restaurant_order_tables"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_order_tables_orderId_idx" ON "restaurant_order_tables"("orderId");

-- CreateIndex
CREATE INDEX "restaurant_order_tables_tableId_idx" ON "restaurant_order_tables"("tableId");

-- CreateIndex
CREATE INDEX "restaurant_order_events_organizationId_idx" ON "restaurant_order_events"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_order_events_orderId_idx" ON "restaurant_order_events"("orderId");

-- CreateIndex
CREATE INDEX "restaurant_order_events_actorStaffProfileId_idx" ON "restaurant_order_events"("actorStaffProfileId");

-- CreateIndex
CREATE INDEX "restaurant_order_events_actorDeviceId_idx" ON "restaurant_order_events"("actorDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_order_events_orderId_sequence_key" ON "restaurant_order_events"("orderId", "sequence");

-- CreateIndex
CREATE INDEX "restaurant_event_outbox_organizationId_idx" ON "restaurant_event_outbox"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_event_outbox_status_nextAttemptAt_idx" ON "restaurant_event_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "restaurant_event_outbox_aggregateType_aggregateId_idx" ON "restaurant_event_outbox"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "restaurant_order_idempotency_keys_organizationId_idx" ON "restaurant_order_idempotency_keys"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_order_idempotency_keys_deviceId_idx" ON "restaurant_order_idempotency_keys"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_order_idempotency_keys_deviceId_key_key" ON "restaurant_order_idempotency_keys"("deviceId", "key");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_tickets_organizationId_idx" ON "restaurant_kitchen_tickets"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_tickets_orderId_idx" ON "restaurant_kitchen_tickets"("orderId");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_tickets_stationId_idx" ON "restaurant_kitchen_tickets"("stationId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_kitchen_tickets_stationId_businessDate_ticketNum_key" ON "restaurant_kitchen_tickets"("stationId", "businessDate", "ticketNumber");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_ticket_items_organizationId_idx" ON "restaurant_kitchen_ticket_items"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_ticket_items_ticketId_idx" ON "restaurant_kitchen_ticket_items"("ticketId");

-- CreateIndex
CREATE INDEX "restaurant_kitchen_ticket_items_orderItemId_idx" ON "restaurant_kitchen_ticket_items"("orderItemId");

-- CreateIndex
CREATE INDEX "restaurant_order_number_sequences_organizationId_idx" ON "restaurant_order_number_sequences"("organizationId");

-- CreateIndex
CREATE INDEX "restaurant_order_number_sequences_branchId_idx" ON "restaurant_order_number_sequences"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_order_number_sequences_branchId_businessDate_key" ON "restaurant_order_number_sequences"("branchId", "businessDate");

-- CreateIndex
CREATE INDEX "restaurant_registered_devices_stationId_idx" ON "restaurant_registered_devices"("stationId");

-- AddForeignKey
ALTER TABLE "restaurant_registered_devices" ADD CONSTRAINT "restaurant_registered_devices_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "restaurant_kitchen_stations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_floors" ADD CONSTRAINT "restaurant_floors_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_floorId_fkey" FOREIGN KEY ("floorId") REFERENCES "restaurant_floors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_server_sections" ADD CONSTRAINT "restaurant_server_sections_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_server_section_tables" ADD CONSTRAINT "restaurant_server_section_tables_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "restaurant_server_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_server_section_tables" ADD CONSTRAINT "restaurant_server_section_tables_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "restaurant_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_server_section_assignments" ADD CONSTRAINT "restaurant_server_section_assignments_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "restaurant_server_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_server_section_assignments" ADD CONSTRAINT "restaurant_server_section_assignments_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_kitchen_stations" ADD CONSTRAINT "restaurant_kitchen_stations_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_station_routing_rules" ADD CONSTRAINT "restaurant_station_routing_rules_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "restaurant_kitchen_stations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_station_routing_rules" ADD CONSTRAINT "restaurant_station_routing_rules_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_station_routing_rules" ADD CONSTRAINT "restaurant_station_routing_rules_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "restaurant_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "restaurant_server_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_serverStaffProfileId_fkey" FOREIGN KEY ("serverStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_staffProfileId_fkey" FOREIGN KEY ("staffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "restaurant_branch_menu_publications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_priceListVersionId_fkey" FOREIGN KEY ("priceListVersionId") REFERENCES "restaurant_price_list_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "restaurant_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "restaurant_product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_remakeOfItemId_fkey" FOREIGN KEY ("remakeOfItemId") REFERENCES "restaurant_order_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_item_modifiers" ADD CONSTRAINT "restaurant_order_item_modifiers_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "restaurant_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_item_modifiers" ADD CONSTRAINT "restaurant_order_item_modifiers_modifierOptionId_fkey" FOREIGN KEY ("modifierOptionId") REFERENCES "restaurant_modifier_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_tables" ADD CONSTRAINT "restaurant_order_tables_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_tables" ADD CONSTRAINT "restaurant_order_tables_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "restaurant_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_events" ADD CONSTRAINT "restaurant_order_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_events" ADD CONSTRAINT "restaurant_order_events_actorStaffProfileId_fkey" FOREIGN KEY ("actorStaffProfileId") REFERENCES "restaurant_staff_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_events" ADD CONSTRAINT "restaurant_order_events_actorDeviceId_fkey" FOREIGN KEY ("actorDeviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_idempotency_keys" ADD CONSTRAINT "restaurant_order_idempotency_keys_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "restaurant_registered_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "restaurant_kitchen_tickets_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "restaurant_kitchen_tickets_stationId_fkey" FOREIGN KEY ("stationId") REFERENCES "restaurant_kitchen_stations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_kitchen_ticket_items" ADD CONSTRAINT "restaurant_kitchen_ticket_items_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "restaurant_kitchen_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_kitchen_ticket_items" ADD CONSTRAINT "restaurant_kitchen_ticket_items_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "restaurant_order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_order_number_sequences" ADD CONSTRAINT "restaurant_order_number_sequences_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Cross-tenant-safe composite integrity (matches M1-L1 / M2-L1 / M3-L1): the
-- (organizationId, id) unique on every new table referenced by a composite FK,
-- so a child can only reference a parent inside its OWN organization.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_floors" ADD CONSTRAINT "restaurant_floors_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "restaurant_tables_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_server_sections" ADD CONSTRAINT "restaurant_server_sections_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_kitchen_stations" ADD CONSTRAINT "restaurant_kitchen_stations_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "restaurant_order_items_organizationId_id_key" UNIQUE ("organizationId", "id");
ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "restaurant_kitchen_tickets_organizationId_id_key" UNIQUE ("organizationId", "id");

-- ---------------------------------------------------------------------------
-- Business uniqueness / integrity the Prisma schema cannot express.
-- ---------------------------------------------------------------------------
-- Restaurant Core: exactly one default kitchen station per branch (partial
-- unique on branchId where isDefault). The routing default falls through here.
CREATE UNIQUE INDEX "restaurant_kitchen_stations_branch_default_key" ON "restaurant_kitchen_stations"("branchId") WHERE "isDefault";
-- A routing rule targets EXACTLY one of product or category (most-specific-wins
-- resolution in station-routing.ts). Encodes the XOR at the DB level.
ALTER TABLE "restaurant_station_routing_rules" ADD CONSTRAINT "restaurant_station_routing_rules_product_xor_category_ck" CHECK (num_nonnulls("productId", "categoryId") = 1);

-- ---------------------------------------------------------------------------
-- Deferred composite tenant foreign keys. Every single-column FK above is also
-- expressed as a (organizationId, <fk>) composite so a cross-organization
-- reference is impossible even inside the platform scope. Nullable FK columns
-- use MATCH SIMPLE (the default), so the composite is checked only when present.
-- (restaurant_order_item_modifiers.modifierOptionId and
-- restaurant_order_items.voidCoAuthorizationId have no composite tenant FK: the
-- M2/M3 rows they reference carry no (organizationId, id) unique and are
-- consumed, never modified - C9. The single-column FK / soft reference stands.)
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_floors" ADD CONSTRAINT "tenant_floor_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_tables" ADD CONSTRAINT "tenant_table_floorId_fk" FOREIGN KEY ("organizationId", "floorId") REFERENCES "restaurant_floors" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_server_sections" ADD CONSTRAINT "tenant_section_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_server_section_tables" ADD CONSTRAINT "tenant_sectiontable_sectionId_fk" FOREIGN KEY ("organizationId", "sectionId") REFERENCES "restaurant_server_sections" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_server_section_tables" ADD CONSTRAINT "tenant_sectiontable_tableId_fk" FOREIGN KEY ("organizationId", "tableId") REFERENCES "restaurant_tables" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_server_section_assignments" ADD CONSTRAINT "tenant_sectionassign_sectionId_fk" FOREIGN KEY ("organizationId", "sectionId") REFERENCES "restaurant_server_sections" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_server_section_assignments" ADD CONSTRAINT "tenant_sectionassign_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_kitchen_stations" ADD CONSTRAINT "tenant_station_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_station_routing_rules" ADD CONSTRAINT "tenant_routing_stationId_fk" FOREIGN KEY ("organizationId", "stationId") REFERENCES "restaurant_kitchen_stations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_station_routing_rules" ADD CONSTRAINT "tenant_routing_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_station_routing_rules" ADD CONSTRAINT "tenant_routing_categoryId_fk" FOREIGN KEY ("organizationId", "categoryId") REFERENCES "restaurant_categories" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_sectionId_fk" FOREIGN KEY ("organizationId", "sectionId") REFERENCES "restaurant_server_sections" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_serverStaffId_fk" FOREIGN KEY ("organizationId", "serverStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_staffId_fk" FOREIGN KEY ("organizationId", "staffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_publicationId_fk" FOREIGN KEY ("organizationId", "publicationId") REFERENCES "restaurant_branch_menu_publications" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_orders" ADD CONSTRAINT "tenant_order_priceListVersionId_fk" FOREIGN KEY ("organizationId", "priceListVersionId") REFERENCES "restaurant_price_list_versions" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "tenant_orderitem_orderId_fk" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "tenant_orderitem_productId_fk" FOREIGN KEY ("organizationId", "productId") REFERENCES "restaurant_products" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "tenant_orderitem_variantId_fk" FOREIGN KEY ("organizationId", "variantId") REFERENCES "restaurant_product_variants" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_items" ADD CONSTRAINT "tenant_orderitem_remakeOfItemId_fk" FOREIGN KEY ("organizationId", "remakeOfItemId") REFERENCES "restaurant_order_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_item_modifiers" ADD CONSTRAINT "tenant_orderitemmod_orderItemId_fk" FOREIGN KEY ("organizationId", "orderItemId") REFERENCES "restaurant_order_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_tables" ADD CONSTRAINT "tenant_ordertable_orderId_fk" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_tables" ADD CONSTRAINT "tenant_ordertable_tableId_fk" FOREIGN KEY ("organizationId", "tableId") REFERENCES "restaurant_tables" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_events" ADD CONSTRAINT "tenant_orderevent_orderId_fk" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_events" ADD CONSTRAINT "tenant_orderevent_actorStaffId_fk" FOREIGN KEY ("organizationId", "actorStaffProfileId") REFERENCES "restaurant_staff_profiles" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_events" ADD CONSTRAINT "tenant_orderevent_actorDeviceId_fk" FOREIGN KEY ("organizationId", "actorDeviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_idempotency_keys" ADD CONSTRAINT "tenant_idempotency_deviceId_fk" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "tenant_ticket_orderId_fk" FOREIGN KEY ("organizationId", "orderId") REFERENCES "restaurant_orders" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_kitchen_tickets" ADD CONSTRAINT "tenant_ticket_stationId_fk" FOREIGN KEY ("organizationId", "stationId") REFERENCES "restaurant_kitchen_stations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_kitchen_ticket_items" ADD CONSTRAINT "tenant_ticketitem_ticketId_fk" FOREIGN KEY ("organizationId", "ticketId") REFERENCES "restaurant_kitchen_tickets" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_kitchen_ticket_items" ADD CONSTRAINT "tenant_ticketitem_orderItemId_fk" FOREIGN KEY ("organizationId", "orderItemId") REFERENCES "restaurant_order_items" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_order_number_sequences" ADD CONSTRAINT "tenant_ordernumseq_branchId_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "restaurant_branches" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "restaurant_registered_devices" ADD CONSTRAINT "tenant_device_stationId_fk" FOREIGN KEY ("organizationId", "stationId") REFERENCES "restaurant_kitchen_stations" ("organizationId", "id") DEFERRABLE INITIALLY DEFERRED;

-- ---------------------------------------------------------------------------
-- Forced org-level RLS on every new table, identical clause to
-- 20260728092000_row_level_security / M1-L1 / M2-L1 / M3-L1 (including the
-- app.is_platform_admin control-plane escape). No branch-level DB policy is
-- invented here (D12 seam); branch scope is enforced in server code above the
-- organization boundary.
-- ---------------------------------------------------------------------------
ALTER TABLE "restaurant_floors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_floors" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_floors" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_tables" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_server_sections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_server_sections" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_server_sections" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_server_section_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_server_section_tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_server_section_tables" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_server_section_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_server_section_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_server_section_assignments" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_kitchen_stations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_kitchen_stations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_kitchen_stations" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_station_routing_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_station_routing_rules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_station_routing_rules" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_orders" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_order_items" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_order_item_modifiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_item_modifiers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_order_item_modifiers" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_order_tables" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_tables" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_order_tables" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_order_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_order_events" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_event_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_event_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_event_outbox" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_order_idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_order_idempotency_keys" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_kitchen_tickets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_kitchen_tickets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_kitchen_tickets" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_kitchen_ticket_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_kitchen_ticket_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_kitchen_ticket_items" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "restaurant_order_number_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_order_number_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_order_number_sequences" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
