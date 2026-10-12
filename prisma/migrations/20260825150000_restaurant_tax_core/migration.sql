-- WHA-170 jurisdiction-neutral tax core. No jurisdiction rates or activation data.
CREATE TYPE "RestaurantTaxVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');
CREATE TYPE "RestaurantTaxPriceMode" AS ENUM ('EXCLUSIVE', 'INCLUSIVE');

CREATE TABLE "restaurant_tax_official_sources" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "authorityCode" TEXT NOT NULL, "documentTitle" TEXT NOT NULL, "sourceUrl" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL, "retrievedAt" TIMESTAMP(3) NOT NULL, "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "restaurant_tax_sources_org_hash_key" ON "restaurant_tax_official_sources"("organizationId", "contentHash");
CREATE INDEX "restaurant_tax_sources_org_idx" ON "restaurant_tax_official_sources"("organizationId");

CREATE TABLE "restaurant_tax_profile_versions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "versionNumber" INTEGER NOT NULL,
  "status" "RestaurantTaxVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "effectiveTo" TIMESTAMP(3),
  "approvalReference" TEXT, "approvedAt" TIMESTAMP(3), "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tax_profile_effective_range" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  CONSTRAINT "tax_profile_published_approval" CHECK ("status" <> 'PUBLISHED' OR ("approvalReference" IS NOT NULL AND "approvedAt" IS NOT NULL AND "publishedAt" IS NOT NULL)),
  CONSTRAINT "restaurant_tax_profile_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "restaurant_tax_profile_branch_version_key" ON "restaurant_tax_profile_versions"("branchId", "versionNumber");
CREATE INDEX "restaurant_tax_profile_org_idx" ON "restaurant_tax_profile_versions"("organizationId");
CREATE INDEX "restaurant_tax_profile_effective_idx" ON "restaurant_tax_profile_versions"("branchId", "status", "effectiveFrom");

CREATE TABLE "restaurant_tax_rule_versions" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "profileVersionId" TEXT NOT NULL, "officialSourceId" TEXT NOT NULL, "ruleCode" TEXT NOT NULL,
  "paymentCategory" TEXT NOT NULL, "priceMode" "RestaurantTaxPriceMode" NOT NULL,
  "rate" DECIMAL(9,6) NOT NULL, "status" "RestaurantTaxVersionStatus" NOT NULL DEFAULT 'DRAFT',
  "effectiveFrom" TIMESTAMP(3) NOT NULL, "effectiveTo" TIMESTAMP(3),
  "approvalReference" TEXT, "approvedAt" TIMESTAMP(3), "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tax_rule_rate" CHECK ("rate" >= 0 AND "rate" <= 1),
  CONSTRAINT "tax_rule_effective_range" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom"),
  CONSTRAINT "tax_rule_published_approval" CHECK ("status" <> 'PUBLISHED' OR ("approvalReference" IS NOT NULL AND "approvedAt" IS NOT NULL AND "publishedAt" IS NOT NULL)),
  CONSTRAINT "restaurant_tax_rule_profile_fkey" FOREIGN KEY ("profileVersionId") REFERENCES "restaurant_tax_profile_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "restaurant_tax_rule_source_fkey" FOREIGN KEY ("officialSourceId") REFERENCES "restaurant_tax_official_sources"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "restaurant_tax_rule_profile_code_key" ON "restaurant_tax_rule_versions"("profileVersionId", "ruleCode");
CREATE INDEX "restaurant_tax_rule_org_idx" ON "restaurant_tax_rule_versions"("organizationId");
CREATE INDEX "restaurant_tax_rule_effective_idx" ON "restaurant_tax_rule_versions"("profileVersionId", "paymentCategory", "effectiveFrom");

CREATE TABLE "restaurant_tax_transaction_snapshots" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "transactionReference" TEXT NOT NULL, "profileVersionId" TEXT NOT NULL,
  "currency" TEXT NOT NULL, "subtotal" DECIMAL(12,2) NOT NULL, "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "serviceChargeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0, "taxTotal" DECIMAL(12,2) NOT NULL,
  "grandTotal" DECIMAL(12,2) NOT NULL, "settledAt" TIMESTAMP(3) NOT NULL,
  "reversesSnapshotId" TEXT, "reversalReason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tax_snapshot_reversal_pair" CHECK (("reversesSnapshotId" IS NULL) = ("reversalReason" IS NULL)),
  CONSTRAINT "tax_snapshot_branch_fkey" FOREIGN KEY ("branchId") REFERENCES "restaurant_branches"("id") ON DELETE RESTRICT,
  CONSTRAINT "tax_snapshot_profile_fkey" FOREIGN KEY ("profileVersionId") REFERENCES "restaurant_tax_profile_versions"("id") ON DELETE RESTRICT,
  CONSTRAINT "tax_snapshot_reversal_fkey" FOREIGN KEY ("reversesSnapshotId") REFERENCES "restaurant_tax_transaction_snapshots"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "restaurant_tax_snapshot_org_ref_key" ON "restaurant_tax_transaction_snapshots"("organizationId", "transactionReference");
CREATE INDEX "restaurant_tax_snapshot_org_idx" ON "restaurant_tax_transaction_snapshots"("organizationId");
CREATE INDEX "restaurant_tax_snapshot_reversal_idx" ON "restaurant_tax_transaction_snapshots"("reversesSnapshotId");

CREATE TABLE "restaurant_tax_rate_bucket_snapshots" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "snapshotId" TEXT NOT NULL, "ruleVersionId" TEXT NOT NULL, "paymentCategory" TEXT NOT NULL,
  "priceMode" "RestaurantTaxPriceMode" NOT NULL, "rate" DECIMAL(9,6) NOT NULL,
  "taxableAmount" DECIMAL(12,2) NOT NULL, "taxAmount" DECIMAL(12,2) NOT NULL,
  "grossAmount" DECIMAL(12,2) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tax_bucket_rate" CHECK ("rate" >= 0 AND "rate" <= 1),
  CONSTRAINT "tax_bucket_snapshot_fkey" FOREIGN KEY ("snapshotId") REFERENCES "restaurant_tax_transaction_snapshots"("id") ON DELETE RESTRICT,
  CONSTRAINT "tax_bucket_rule_fkey" FOREIGN KEY ("ruleVersionId") REFERENCES "restaurant_tax_rule_versions"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "restaurant_tax_bucket_snapshot_rule_category_key" ON "restaurant_tax_rate_bucket_snapshots"("snapshotId", "ruleVersionId", "paymentCategory");
CREATE INDEX "restaurant_tax_bucket_org_idx" ON "restaurant_tax_rate_bucket_snapshots"("organizationId");

CREATE FUNCTION reject_tax_immutable_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'tax record is immutable' USING ERRCODE = '55000'; END; $$;

CREATE FUNCTION guard_tax_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'DRAFT' THEN RAISE EXCEPTION 'published tax version is immutable' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION guard_tax_profile_overlap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'PUBLISHED' AND EXISTS (
    SELECT 1 FROM "restaurant_tax_profile_versions" p
    WHERE p."id" <> NEW."id" AND p."organizationId" = NEW."organizationId" AND p."branchId" = NEW."branchId"
      AND p."status" = 'PUBLISHED'
      AND tsrange(p."effectiveFrom", p."effectiveTo", '[)') && tsrange(NEW."effectiveFrom", NEW."effectiveTo", '[)')
  ) THEN RAISE EXCEPTION 'overlapping published tax profile' USING ERRCODE = '23P01'; END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER tax_source_immutable BEFORE UPDATE OR DELETE ON "restaurant_tax_official_sources" FOR EACH ROW EXECUTE FUNCTION reject_tax_immutable_mutation();
CREATE TRIGGER tax_profile_immutable BEFORE UPDATE OR DELETE ON "restaurant_tax_profile_versions" FOR EACH ROW EXECUTE FUNCTION guard_tax_version_mutation();
CREATE TRIGGER tax_rule_immutable BEFORE UPDATE OR DELETE ON "restaurant_tax_rule_versions" FOR EACH ROW EXECUTE FUNCTION guard_tax_version_mutation();
CREATE TRIGGER tax_profile_overlap BEFORE INSERT OR UPDATE ON "restaurant_tax_profile_versions" FOR EACH ROW EXECUTE FUNCTION guard_tax_profile_overlap();
CREATE TRIGGER tax_snapshot_immutable BEFORE UPDATE OR DELETE ON "restaurant_tax_transaction_snapshots" FOR EACH ROW EXECUTE FUNCTION reject_tax_immutable_mutation();
CREATE TRIGGER tax_bucket_immutable BEFORE UPDATE OR DELETE ON "restaurant_tax_rate_bucket_snapshots" FOR EACH ROW EXECUTE FUNCTION reject_tax_immutable_mutation();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['restaurant_tax_official_sources','restaurant_tax_profile_versions','restaurant_tax_rule_versions','restaurant_tax_transaction_snapshots','restaurant_tax_rate_bucket_snapshots'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', t || '_tenant', t);
  END LOOP;
END $$;
