CREATE TABLE "hotel_rate_plans" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "roomTypeId" TEXT NOT NULL,
  "taxProfileId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "validFrom" DATE NOT NULL,
  "validTo" DATE NOT NULL,
  "minAdults" INTEGER NOT NULL DEFAULT 1,
  "maxAdults" INTEGER NOT NULL,
  "maxChildren" INTEGER NOT NULL DEFAULT 0,
  "nightlyRateMinor" INTEGER NOT NULL,
  "taxRateBps" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "hotel_rate_plan_values_ck" CHECK (
    "validTo" > "validFrom" AND "minAdults" >= 1 AND "maxAdults" >= "minAdults"
    AND "maxChildren" >= 0 AND "nightlyRateMinor" >= 0 AND "taxRateBps" BETWEEN 0 AND 100000
  ),
  CONSTRAINT "hotel_rate_plans_property_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "hotel_properties"("organizationId", "branchId") ON DELETE RESTRICT,
  CONSTRAINT "hotel_rate_plans_room_type_fkey" FOREIGN KEY ("organizationId", "branchId", "roomTypeId") REFERENCES "hotel_room_types"("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "hotel_rate_plans_scope_key" ON "hotel_rate_plans"("organizationId", "branchId", "id");
CREATE UNIQUE INDEX "hotel_rate_plans_code_version_key" ON "hotel_rate_plans"("organizationId", "branchId", "code", "version");
CREATE INDEX "hotel_rate_plans_lookup_idx" ON "hotel_rate_plans"("organizationId", "branchId", "roomTypeId", "validFrom", "validTo", "active");
ALTER TABLE "hotel_rate_plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hotel_rate_plans" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "hotel_rate_plans" USING ("organizationId" = current_setting('app.current_organization_id', true)) WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
