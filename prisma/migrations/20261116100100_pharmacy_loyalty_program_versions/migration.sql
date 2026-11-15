BEGIN;

-- DEV-746: owner-configurable loyalty earning, kept apart from the fixed redemption value.
-- Additive only. No existing points entry is updated or deleted, so every customer balance
-- (the sum of its entries) is exactly what it was. No program version is seeded: a tenant
-- earns nothing new until its owner sets a rate, and no default rate is invented here.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PharmacyLoyaltyEarnMode') THEN
    CREATE TYPE "PharmacyLoyaltyEarnMode" AS ENUM ('PERCENT_OF_SPEND', 'POINTS_PER_SPEND_STEP');
  END IF;
END $$;

-- Points earned when a khata (credit) debt is paid at the counter.
ALTER TYPE "PharmacyLoyaltyEntryKind" ADD VALUE IF NOT EXISTS 'KHATA_EARN';

CREATE TABLE IF NOT EXISTS "pharmacy_loyalty_program_versions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "version" INTEGER NOT NULL,
  "earnMode" "PharmacyLoyaltyEarnMode" NOT NULL,
  "earnPoints" INTEGER NOT NULL,
  "perSpendMinor" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actorId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_loyalty_program_versions_org_id_key" UNIQUE ("organizationId", "id"),
  CONSTRAINT "pharmacy_loyalty_program_versions_org_version_key" UNIQUE ("organizationId", "version"),
  CONSTRAINT "pharmacy_loyalty_program_versions_rule_check" CHECK (
    "version" > 0 AND "earnPoints" > 0 AND "perSpendMinor" > 0 AND
    -- One point redeems for PKR 1 (100 minor): never pay back more than was spent.
    "earnPoints"::bigint * 100 <= "perSpendMinor"::bigint
  )
);

-- Dated and immutable: a new rate is a new version; history is never rewritten.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'pharmacy_loyalty_program_versions_append_only'
  ) THEN
    CREATE TRIGGER pharmacy_loyalty_program_versions_append_only
    BEFORE UPDATE OR DELETE ON "pharmacy_loyalty_program_versions"
    FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();
  END IF;
END $$;

ALTER TABLE "pharmacy_loyalty_program_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_loyalty_program_versions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_loyalty_program_versions";
CREATE POLICY tenant_isolation ON "pharmacy_loyalty_program_versions"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "pharmacy_loyalty_points_entries"
  ADD COLUMN IF NOT EXISTS "programVersionId" TEXT,
  ADD COLUMN IF NOT EXISTS "earnStartMinor" INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pharmacy_loyalty_points_entries_program_version_fkey'
  ) THEN
    ALTER TABLE "pharmacy_loyalty_points_entries"
      ADD CONSTRAINT "pharmacy_loyalty_points_entries_program_version_fkey"
      FOREIGN KEY ("organizationId", "programVersionId")
      REFERENCES "pharmacy_loyalty_program_versions" ("organizationId", "id") ON DELETE RESTRICT;
  END IF;
END $$;

-- Every existing shape is kept unchanged (existing rows have no earnStartMinor). KHATA_EARN
-- is compared as text: a new enum value cannot be used in the transaction that adds it.
ALTER TABLE "pharmacy_loyalty_points_entries"
  DROP CONSTRAINT IF EXISTS pharmacy_loyalty_points_entries_sign_check,
  ADD CONSTRAINT pharmacy_loyalty_points_entries_sign_check CHECK (
    ("kind"::text = 'EARN' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NULL AND "refundId" IS NULL AND "earnStartMinor" IS NULL) OR
    ("kind"::text = 'REDEEM' AND "points" < 0 AND "requestedPoints" > 0 AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NULL AND "earnStartMinor" IS NULL) OR
    ("kind"::text = 'REFUND' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NULL AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL AND "earnStartMinor" IS NULL) OR
    ("kind"::text = 'EARN_REVERSAL' AND "points" < 0 AND "requestedPoints" IS NULL AND "netPaidMinor" IS NOT NULL AND "netPaidMinor" >= 0 AND "tenderId" IS NOT NULL AND "refundId" IS NOT NULL AND "earnStartMinor" IS NULL) OR
    ("kind"::text = 'KHATA_EARN' AND "points" > 0 AND "requestedPoints" IS NULL AND "netPaidMinor" > 0 AND "earnStartMinor" >= 0 AND "tenderId" IS NOT NULL AND "refundId" IS NULL AND "programVersionId" IS NOT NULL)
  );

COMMIT;
