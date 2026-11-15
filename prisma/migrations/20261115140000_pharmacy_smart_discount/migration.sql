-- DEV-66: smart discounting below MRP with a minimum-margin guard.
--
-- pharmacy_branches.discountPolicy   owner-configured policy (minimum margin,
--                                     maximum suggested depth, evidence windows);
--                                     NULL means the safe defaults, which keep the
--                                     existing never-below-cost floor.
-- pharmacy_competitor_price_observations
--                                     APPEND-ONLY competitor discount log with
--                                     forced tenant/branch RLS and SELECT + INSERT
--                                     policies only.
--
-- Additive and idempotent: nothing is changed or backfilled.
BEGIN;

ALTER TABLE "pharmacy_branches" ADD COLUMN IF NOT EXISTS "discountPolicy" JSONB;
ALTER TABLE "pharmacy_branches"
  ADD COLUMN IF NOT EXISTS "discountPolicyRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "pharmacy_competitor_price_observations" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "medicineId" TEXT NOT NULL,
  "packLevelId" TEXT NOT NULL,
  "competitorLabel" TEXT NOT NULL,
  "observedPriceMinor" INTEGER NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "recordedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_competitor_price_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_competitor_price_obs_branch_fkey"
    FOREIGN KEY ("organizationId", "branchId")
    REFERENCES "pharmacy_branches" ("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_competitor_price_obs_medicine_fkey"
    FOREIGN KEY ("organizationId", "medicineId")
    REFERENCES "pharmacy_medicines" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_competitor_price_obs_pack_level_fkey"
    FOREIGN KEY ("organizationId", "packLevelId")
    REFERENCES "pharmacy_pack_levels" ("organizationId", "id") ON DELETE RESTRICT,
  CONSTRAINT "pharmacy_competitor_price_obs_check" CHECK (
    length(btrim("id")) > 0 AND
    length(btrim("branchId")) > 0 AND
    length(btrim("medicineId")) > 0 AND
    length(btrim("packLevelId")) > 0 AND
    length(btrim("competitorLabel")) BETWEEN 1 AND 80 AND
    length(btrim("recordedByUserId")) > 0 AND
    "observedPriceMinor" > 0
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_competitor_price_observations_org_id_key"
  ON "pharmacy_competitor_price_observations" ("organizationId", "id");
CREATE INDEX IF NOT EXISTS "pharmacy_competitor_price_obs_medicine_idx"
  ON "pharmacy_competitor_price_observations" ("organizationId", "branchId", "medicineId", "packLevelId", "observedAt");

ALTER TABLE "pharmacy_competitor_price_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_competitor_price_observations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_branch_isolation_select ON "pharmacy_competitor_price_observations";
CREATE POLICY tenant_branch_isolation_select ON "pharmacy_competitor_price_observations" FOR SELECT
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  );
DROP POLICY IF EXISTS tenant_branch_isolation_insert ON "pharmacy_competitor_price_observations";
CREATE POLICY tenant_branch_isolation_insert ON "pharmacy_competitor_price_observations" FOR INSERT
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR
      "branchId" = current_setting('app.current_branch_id', true)))
  );

COMMIT;
