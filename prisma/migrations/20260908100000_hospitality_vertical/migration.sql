-- H1-01 — the HOSPITALITY vertical and its PROP-01 property registry.
--
-- The new enum value is added first and is NOT used anywhere else in this
-- migration: PostgreSQL refuses to read an enum value added in the same
-- transaction that added it, and Prisma runs each migration in one transaction.
-- Same shape as 20260902120000_pharmacy_vertical.
ALTER TYPE "OrganizationVertical" ADD VALUE IF NOT EXISTS 'HOSPITALITY';

-- MODE-01: the mode selects defaults, never a code branch outside the
-- defaults/packaging layer.
CREATE TYPE "HotelPropertyMode" AS ENUM ('HOTEL', 'HOSTEL', 'APARTMENT', 'RESORT', 'VENUE');

-- PROP-01 (05 §1.1). In hospitality the branch IS the property, so "branchId" is
-- this row's own primary key and every later hotel table references it as its
-- branch. Money is PKR minor units across the vertical.
CREATE TABLE "hotel_properties" (
  "branchId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "name" TEXT NOT NULL,
  "addressLine" TEXT NOT NULL,
  "city" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "mode" "HotelPropertyMode" NOT NULL DEFAULT 'HOTEL',
  "starCategory" INTEGER,
  "checkInTime" TEXT NOT NULL DEFAULT '14:00',
  "checkOutTime" TEXT NOT NULL DEFAULT '12:00',
  "auditTime" TEXT NOT NULL DEFAULT '03:00',
  "currency" TEXT NOT NULL DEFAULT 'PKR',
  "taxProfileId" TEXT,
  "languages" TEXT[] NOT NULL DEFAULT ARRAY['en', 'ur']::TEXT[],
  "overbookPolicy" JSONB NOT NULL DEFAULT '{}',
  "bookingEngineSlug" TEXT NOT NULL,
  "journeySettings" JSONB NOT NULL DEFAULT '{}',
  "mealAllocationPolicy" JSONB NOT NULL DEFAULT '{}',
  "businessDatePolicy" JSONB NOT NULL DEFAULT '{}',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_properties_pkey" PRIMARY KEY ("branchId"),
  -- 24-hour local times. Stored as text so a property's own zone owns them, and
  -- constrained here so no surface has to defend against '25:00' or '2pm'.
  CONSTRAINT "hotel_properties_times_ck" CHECK (
    "checkInTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "checkOutTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND "auditTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT "hotel_properties_star_ck" CHECK ("starCategory" IS NULL OR ("starCategory" BETWEEN 1 AND 7)),
  CONSTRAINT "hotel_properties_currency_ck" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "hotel_properties_languages_ck" CHECK (array_length("languages", 1) >= 1),
  CONSTRAINT "hotel_properties_facts_ck" CHECK (
    length(btrim("name")) > 0
    AND length(btrim("addressLine")) > 0
    AND length(btrim("city")) > 0
    AND length(btrim("timezone")) > 0
  ),
  -- CH-01: the slug is the public direct-booking path segment.
  CONSTRAINT "hotel_properties_slug_ck" CHECK ("bookingEngineSlug" ~ '^[a-z0-9]([a-z0-9-]{1,62})[a-z0-9]$')
);

CREATE UNIQUE INDEX "hotel_properties_org_branch_key" ON "hotel_properties"("organizationId", "branchId");
CREATE UNIQUE INDEX "hotel_properties_org_slug_key" ON "hotel_properties"("organizationId", "bookingEngineSlug");
CREATE INDEX "hotel_properties_org_active_idx" ON "hotel_properties"("organizationId", "active");

-- Tenant isolation is the database's job and is forced for the table owner too,
-- so a migration or a job running as the owner cannot read across tenants either.
ALTER TABLE "hotel_properties" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_properties" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hotel_properties_tenant_isolation" ON "hotel_properties"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
