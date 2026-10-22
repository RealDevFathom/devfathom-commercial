-- HK-02: property-scoped housekeeping state and work queue.
CREATE TYPE "HotelHousekeepingStatus" AS ENUM ('CLEAN', 'DIRTY', 'INSPECTED', 'OUT_OF_ORDER');
CREATE TYPE "HotelHousekeepingTaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

CREATE TABLE "hotel_room_housekeeping" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL,
  "branchId" text NOT NULL,
  "roomId" text NOT NULL,
  "status" "HotelHousekeepingStatus" NOT NULL DEFAULT 'DIRTY',
  "changedById" text NOT NULL,
  "changedAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "branchId", "id"),
  UNIQUE ("organizationId", "branchId", "roomId"),
  CONSTRAINT "hotel_room_housekeeping_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties" ("organizationId", "branchId") ON DELETE RESTRICT,
  CONSTRAINT "hotel_room_housekeeping_room_fkey" FOREIGN KEY ("organizationId", "branchId", "roomId") REFERENCES "hotel_rooms" ("organizationId", "branchId", "id") ON DELETE CASCADE
);

CREATE TABLE "hotel_housekeeping_tasks" (
  "id" text PRIMARY KEY,
  "organizationId" text NOT NULL,
  "branchId" text NOT NULL,
  "roomId" text NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 160),
  "notes" text,
  "status" "HotelHousekeepingTaskStatus" NOT NULL DEFAULT 'OPEN',
  "assignedToId" text,
  "createdById" text NOT NULL,
  "completedById" text,
  "completedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "branchId", "id"),
  CONSTRAINT "hotel_housekeeping_tasks_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties" ("organizationId", "branchId") ON DELETE RESTRICT,
  CONSTRAINT "hotel_housekeeping_tasks_room_fkey" FOREIGN KEY ("organizationId", "branchId", "roomId") REFERENCES "hotel_rooms" ("organizationId", "branchId", "id") ON DELETE CASCADE,
  CONSTRAINT "hotel_housekeeping_tasks_completion_check" CHECK (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL AND "completedById" IS NOT NULL))
);

CREATE INDEX "hotel_room_housekeeping_branch_status_idx" ON "hotel_room_housekeeping" ("organizationId", "branchId", "status");
CREATE INDEX "hotel_housekeeping_tasks_branch_status_idx" ON "hotel_housekeeping_tasks" ("organizationId", "branchId", "status");

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['hotel_room_housekeeping', 'hotel_housekeeping_tasks'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY hotel_scope ON %I USING ("organizationId"=current_setting(''app.current_organization_id'',true) AND "branchId"=current_setting(''app.current_hotel_property_id'',true)) WITH CHECK ("organizationId"=current_setting(''app.current_organization_id'',true) AND "branchId"=current_setting(''app.current_hotel_property_id'',true))', t);
  END LOOP;
END $$;
