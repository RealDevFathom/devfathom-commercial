-- #751: competitor evidence only. Suggestions are advisory and retain the existing approval path.
CREATE TABLE "pharmacy_competitor_discount_observations" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "competitor" TEXT NOT NULL,
  "competitorPriceMinor" INTEGER NOT NULL CHECK ("competitorPriceMinor" > 0),
  "observedDemandUnits" INTEGER NOT NULL CHECK ("observedDemandUnits" > 0),
  "observedAt" TIMESTAMPTZ NOT NULL,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "pharmacy_competitor_discount_observation_branch_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_competitor_discount_observation_medicine_fk" FOREIGN KEY ("organizationId", "medicineId") REFERENCES "pharmacy_medicines"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_competitor_discount_observation_item_idx" ON "pharmacy_competitor_discount_observations" ("organizationId", "branchId", "medicineId", "packLevelId", "observedAt" DESC);
ALTER TABLE "pharmacy_competitor_discount_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_competitor_discount_observations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_competitor_discount_observations"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));

CREATE TABLE "pharmacy_smart_discount_policies" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "minimumMarginBps" INTEGER NOT NULL CHECK ("minimumMarginBps" BETWEEN 0 AND 9999),
  "minimumObservations" INTEGER NOT NULL CHECK ("minimumObservations" BETWEEN 2 AND 1000),
  "targetDemandLiftBps" INTEGER NOT NULL CHECK ("targetDemandLiftBps" BETWEEN 0 AND 100000),
  "updatedById" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("organizationId", "branchId"),
  CONSTRAINT "pharmacy_smart_discount_policy_branch_fk" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT
);
ALTER TABLE "pharmacy_smart_discount_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_smart_discount_policies" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_smart_discount_policies"
  USING ("organizationId" = current_setting('app.current_organization_id', true))
  WITH CHECK ("organizationId" = current_setting('app.current_organization_id', true));
