-- MKT-01/MKT-02, PRD §8A invariants 20–23: auditable retail-only segments,
-- consent-gated capture campaigns, fail-closed regulated outreach and estimated attribution.
CREATE TYPE "PharmacyMarketingChannel" AS ENUM ('SMS', 'WHATSAPP', 'EMAIL');
CREATE TYPE "PharmacyCampaignStatus" AS ENUM ('DRAFT', 'APPROVED', 'CAPTURED', 'REFUSED');

CREATE TABLE "pharmacy_marketing_segments" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "definition" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "createdByUserId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "branchId", "name", "version"),
  CHECK (jsonb_typeof("definition") = 'object'),
  CHECK ("definition"::text !~* '(prescription|condition|allerg|medicine|diagnos|patient|drug|rx)')
);
CREATE TABLE "pharmacy_marketing_templates" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "channel" "PharmacyMarketingChannel" NOT NULL, "body" TEXT NOT NULL,
  "approvedByUserId" TEXT NOT NULL, "approvedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  CHECK ("body" !~* '(prescription|condition|allerg|medicine|diagnos|patient|drug|rx)')
);
CREATE TABLE "pharmacy_campaigns" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "segmentId" TEXT NOT NULL, "templateId" TEXT NOT NULL,
  "scheduledAt" TIMESTAMP(3) NOT NULL, "quietHours" JSONB NOT NULL, "frequencyCap" JSONB NOT NULL,
  "promotesRegulatedItem" BOOLEAN NOT NULL DEFAULT false,
  "status" "PharmacyCampaignStatus" NOT NULL DEFAULT 'DRAFT',
  "ownerApprovedByUserId" TEXT, "ownerApprovedAt" TIMESTAMP(3), "refusalReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"),
  FOREIGN KEY ("organizationId", "segmentId") REFERENCES "pharmacy_marketing_segments"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "templateId") REFERENCES "pharmacy_marketing_templates"("organizationId", "id") ON DELETE RESTRICT,
  CHECK ("status" = 'DRAFT' OR ("ownerApprovedByUserId" IS NOT NULL AND "ownerApprovedAt" IS NOT NULL)),
  CHECK (NOT "promotesRegulatedItem" OR "status" IN ('DRAFT', 'REFUSED'))
);
CREATE INDEX "pharmacy_campaigns_org_branch_schedule_idx" ON "pharmacy_campaigns"("organizationId", "branchId", "scheduledAt");

CREATE TABLE "pharmacy_campaign_captures" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "channel" "PharmacyMarketingChannel" NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "idempotencyKey"),
  FOREIGN KEY ("organizationId", "campaignId") REFERENCES "pharmacy_campaigns"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_campaign_captures_org_branch_campaign_idx" ON "pharmacy_campaign_captures"("organizationId", "branchId", "campaignId", "capturedAt");
CREATE TABLE "pharmacy_campaign_exclusions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL, "customerId" TEXT NOT NULL, "reason" TEXT NOT NULL,
  "evidence" JSONB NOT NULL, "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "campaignId", "customerId"),
  FOREIGN KEY ("organizationId", "campaignId") REFERENCES "pharmacy_campaigns"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT
);
CREATE TABLE "pharmacy_campaign_attributions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL, "visitId" TEXT NOT NULL, "receiptId" TEXT NOT NULL,
  "method" TEXT NOT NULL, "windowDays" INTEGER NOT NULL, "exclusions" JSONB NOT NULL,
  "confidence" TEXT NOT NULL, "recoveredSalesMinor" INTEGER NOT NULL,
  "recoveredMarginMinor" INTEGER NOT NULL, "messageCostMinor" INTEGER NOT NULL,
  "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "campaignId", "visitId", "receiptId"),
  FOREIGN KEY ("organizationId", "campaignId") REFERENCES "pharmacy_campaigns"("organizationId", "id") ON DELETE RESTRICT,
  CHECK ("windowDays" > 0 AND btrim("method") <> '' AND btrim("confidence") <> ''),
  CHECK ("recoveredSalesMinor" >= 0 AND "recoveredMarginMinor" >= 0 AND "messageCostMinor" >= 0)
);

-- Every new table is tenant + branch scoped. Branch is checked against the
-- session branch when set; administrative tenant reads may leave it unset.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['pharmacy_marketing_segments','pharmacy_marketing_templates','pharmacy_campaigns','pharmacy_campaign_captures','pharmacy_campaign_exclusions','pharmacy_campaign_attributions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_branch_isolation ON %I USING ((current_setting(''app.is_platform_admin'', true) = ''true'') OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), '''')))) WITH CHECK ((current_setting(''app.is_platform_admin'', true) = ''true'') OR ("organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''') AND (NULLIF(current_setting(''app.current_branch_id'', true), '''') IS NULL OR "branchId" = NULLIF(current_setting(''app.current_branch_id'', true), ''''))))', t);
  END LOOP;
END $$;
