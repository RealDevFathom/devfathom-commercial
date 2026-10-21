-- H1-06 (PROP-05) — the extras and services catalog every folio charge names.
--
-- One new table with its own two enums. Nothing existing is altered: the vertical
-- gains a catalog, not a change of shape.

-- One department vocabulary for the whole vertical. Reports ("revenue by
-- department"), the month-end pack and the API-03 GL mapping all group by it, so
-- it is a closed enum rather than free text.
CREATE TYPE "HotelDepartment" AS ENUM (
  'ROOMS',
  'DAY_USE',
  'FOOD_BEVERAGE',
  'MINIBAR',
  'LAUNDRY',
  'SPA',
  'TRANSPORT',
  'TELEPHONE',
  'BUSINESS_CENTRE',
  'BANQUET',
  'UTILITIES',
  'NO_SHOW',
  'CANCELLATION',
  'MISCELLANEOUS'
);

-- PROP-05 ★ recurrence. PER_PERIOD follows a rate plan's billing cycle, which is
-- why the application refuses to pair it with a nightly one.
CREATE TYPE "HotelExtraRecurrence" AS ENUM (
  'NONE',
  'PER_NIGHT',
  'PER_STAY',
  'PER_PERSON',
  'PER_PERIOD'
);

-- PROP-05 (05 §1.1). Scoped to the property, because a chain's two properties
-- price the same service differently. Money in PKR minor units.
CREATE TABLE "hotel_extras" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameUr" TEXT,
  "priceMinor" INTEGER NOT NULL,
  "taxClass" TEXT NOT NULL,
  "department" "HotelDepartment" NOT NULL,
  "postingRule" JSONB NOT NULL DEFAULT '{}',
  "upsellable" BOOLEAN NOT NULL DEFAULT false,
  "upsellPriceMinor" INTEGER,
  "recurring" "HotelExtraRecurrence" NOT NULL DEFAULT 'NONE',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_extras_pkey" PRIMARY KEY ("id"),
  -- The code appears on a folio line and in a GL export, so it is a code and not
  -- a sentence.
  CONSTRAINT "hotel_extras_code_ck" CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  -- Same rule for the tax class: it keys into the property's tax profile.
  CONSTRAINT "hotel_extras_tax_class_ck" CHECK ("taxClass" ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  CONSTRAINT "hotel_extras_names_ck" CHECK (
    length(btrim("name")) > 0
    AND ("nameUr" IS NULL OR length(btrim("nameUr")) > 0)
  ),
  -- PKR minor units, never negative: a discount is a folio line of its own, not a
  -- catalog item priced below zero.
  CONSTRAINT "hotel_extras_price_ck" CHECK ("priceMinor" >= 0),
  -- PROP-05 ★: an offer price only exists on an item that may be offered. Enforced
  -- here as well as in `src/lib/hotel/extras.ts`, so an import or a hand-written
  -- row cannot carry a price nothing can ever quote.
  CONSTRAINT "hotel_extras_upsell_ck" CHECK (
    "upsellPriceMinor" IS NULL
    OR ("upsellable" AND "upsellPriceMinor" >= 0)
  ),
  -- The catalog belongs to a property of the same tenant. The composite reference
  -- is what makes the organization part of the join rather than a hope.
  CONSTRAINT "hotel_extras_property_fkey" FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "hotel_extras_org_id_key" ON "hotel_extras"("organizationId", "id");
CREATE UNIQUE INDEX "hotel_extras_org_branch_code_key" ON "hotel_extras"("organizationId", "branchId", "code");
CREATE INDEX "hotel_extras_org_branch_active_idx" ON "hotel_extras"("organizationId", "branchId", "active");
CREATE INDEX "hotel_extras_org_branch_department_idx" ON "hotel_extras"("organizationId", "branchId", "department");

-- Tenant isolation is the database's job and is forced for the table owner too,
-- so a migration or a maintenance job cannot read across tenants either.
ALTER TABLE "hotel_extras" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_extras" FORCE ROW LEVEL SECURITY;

CREATE POLICY "hotel_extras_tenant_isolation" ON "hotel_extras"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
