-- #756: staged metadata-only additions keep existing campaign rows valid without
-- rewriting the table. NOT VALID constraints are checked without the long
-- ACCESS EXCLUSIVE lock taken by an immediately validated CHECK.
ALTER TABLE "pharmacy_campaigns"
  ADD COLUMN "voucherEnabled" BOOLEAN DEFAULT false,
  ADD COLUMN "eligibleCategoryAllowlist" JSONB DEFAULT '["FRONT_SHOP"]'::jsonb,
  ADD COLUMN "voucherDiscountMinor" INTEGER;

ALTER TABLE "pharmacy_campaigns"
  ADD CONSTRAINT "pharmacy_campaign_voucher_columns_nn_ck"
    CHECK ("voucherEnabled" IS NOT NULL AND "eligibleCategoryAllowlist" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "pharmacy_campaign_voucher_categories_ck"
    CHECK (
      (NOT "voucherEnabled" AND "voucherDiscountMinor" IS NULL)
      OR ("voucherEnabled" AND "eligibleCategoryAllowlist" = '["FRONT_SHOP"]'::jsonb
          AND "voucherDiscountMinor" > 0)
    ) NOT VALID;

ALTER TABLE "pharmacy_campaigns" VALIDATE CONSTRAINT "pharmacy_campaign_voucher_columns_nn_ck";
ALTER TABLE "pharmacy_campaigns" VALIDATE CONSTRAINT "pharmacy_campaign_voucher_categories_ck";
ALTER TABLE "pharmacy_campaigns"
  ALTER COLUMN "voucherEnabled" SET NOT NULL,
  ALTER COLUMN "eligibleCategoryAllowlist" SET NOT NULL;

CREATE TABLE "pharmacy_voucher_redemptions" (
  "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL, "captureId" TEXT NOT NULL, "customerId" TEXT NOT NULL,
  "saleLineId" TEXT NOT NULL, "discountMinor" INTEGER NOT NULL CHECK ("discountMinor" > 0),
  "redeemedByUserId" TEXT NOT NULL, "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", "id"), UNIQUE ("organizationId", "captureId"),
  UNIQUE ("organizationId", "branchId", "saleLineId"),
  FOREIGN KEY ("organizationId", "campaignId") REFERENCES "pharmacy_campaigns"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "captureId") REFERENCES "pharmacy_campaign_captures"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId", "saleLineId") REFERENCES "pharmacy_sale_lines"("organizationId", "branchId", "id") ON DELETE RESTRICT
);
CREATE INDEX "pharmacy_voucher_redemptions_org_branch_campaign_idx"
  ON "pharmacy_voucher_redemptions"("organizationId", "branchId", "campaignId", "redeemedAt");
ALTER TABLE "pharmacy_voucher_redemptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_voucher_redemptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branch_isolation ON "pharmacy_voucher_redemptions"
  USING ((current_setting('app.is_platform_admin', true) = 'true') OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))))
  WITH CHECK ((current_setting('app.is_platform_admin', true) = 'true') OR
    ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '') AND
     (NULLIF(current_setting('app.current_branch_id', true), '') IS NULL OR "branchId" = NULLIF(current_setting('app.current_branch_id', true), ''))));
