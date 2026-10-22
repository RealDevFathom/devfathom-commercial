-- Additive DDL only. Fail instead of waiting behind a busy loyalty table; deploy tooling retries off-peak.
SET lock_timeout = '5s';

ALTER TABLE pharmacy_loyalty_settings
  ADD COLUMN "winBackEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "winBackInactivityDays" INTEGER NOT NULL DEFAULT 45 CHECK ("winBackInactivityDays" BETWEEN 1 AND 3650),
  ADD COLUMN "winBackWindowDays" INTEGER NOT NULL DEFAULT 30 CHECK ("winBackWindowDays" BETWEEN 1 AND 365),
  ADD COLUMN "winBackMinimumSpendMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("winBackMinimumSpendMinor" BETWEEN 0 AND 2147483647),
  ADD COLUMN "winBackMinNextBasketMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("winBackMinNextBasketMinor" BETWEEN 0 AND 2147483647),
  ADD COLUMN "winBackDefaultMarginBasisPoints" INTEGER NOT NULL DEFAULT 1450 CHECK ("winBackDefaultMarginBasisPoints" BETWEEN 0 AND 10000),
  ADD COLUMN "winBackRedemptionBasisPoints" INTEGER NOT NULL DEFAULT 2500 CHECK ("winBackRedemptionBasisPoints" BETWEEN 0 AND 10000),
  ADD COLUMN "winBackEnabledPreviewId" TEXT,
  ADD COLUMN "winBackEnabledPreviewHash" TEXT;

CREATE TABLE pharmacy_win_back_tiers (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "minimumSpendMinor" INTEGER NOT NULL CHECK ("minimumSpendMinor" BETWEEN 0 AND 2147483647), "maximumSpendMinor" INTEGER CHECK ("maximumSpendMinor" BETWEEN "minimumSpendMinor" AND 2147483647),
  "voucherValueMinor" INTEGER NOT NULL CHECK ("voucherValueMinor" BETWEEN 20000 AND 100000), position INTEGER NOT NULL CHECK (position >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id), UNIQUE ("organizationId", position),
  FOREIGN KEY ("organizationId") REFERENCES pharmacy_loyalty_settings ("organizationId") ON DELETE CASCADE
);
CREATE TABLE pharmacy_win_back_category_margins (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "categoryId" TEXT NOT NULL,
  "marginBasisPoints" INTEGER NOT NULL DEFAULT 1450 CHECK ("marginBasisPoints" BETWEEN 0 AND 10000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id), UNIQUE ("organizationId", "categoryId"),
  FOREIGN KEY ("organizationId") REFERENCES pharmacy_loyalty_settings ("organizationId") ON DELETE CASCADE
);
CREATE TABLE pharmacy_win_back_previews (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "settingsHash" TEXT NOT NULL,
  "eligibleCustomerCount" INTEGER NOT NULL, "totalVoucherLiabilityMinor" INTEGER NOT NULL, "expectedRedemptions" INTEGER NOT NULL,
  "expectedVoucherCostMinor" INTEGER NOT NULL, "expectedMarginMinor" INTEGER NOT NULL, "netMarginImpactMinor" INTEGER NOT NULL,
  "redemptionBasisPoints" INTEGER NOT NULL, "generatedByActorId" TEXT NOT NULL, "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id),
  FOREIGN KEY ("organizationId") REFERENCES pharmacy_loyalty_settings ("organizationId") ON DELETE CASCADE
);
CREATE INDEX pharmacy_win_back_previews_generated_idx ON pharmacy_win_back_previews ("organizationId", "generatedAt");
ALTER TABLE pharmacy_loyalty_settings
  ADD CONSTRAINT pharmacy_loyalty_settings_win_back_preview_fkey
  FOREIGN KEY ("organizationId", "winBackEnabledPreviewId")
  REFERENCES pharmacy_win_back_previews ("organizationId", id) ON DELETE RESTRICT;
CREATE TABLE pharmacy_win_back_issuances (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "customerId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
  "voucherId" TEXT, "campaignWindowStart" TIMESTAMP(3) NOT NULL, "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id), UNIQUE ("organizationId", "customerId", "campaignWindowStart"), UNIQUE ("organizationId", "voucherId"),
  FOREIGN KEY ("organizationId") REFERENCES pharmacy_loyalty_settings ("organizationId") ON DELETE CASCADE,
  FOREIGN KEY ("organizationId", "customerId") REFERENCES pharmacy_customers ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "branchId") REFERENCES pharmacy_branches ("organizationId", id) ON DELETE RESTRICT,
  FOREIGN KEY ("organizationId", "voucherId") REFERENCES pharmacy_vouchers ("organizationId", id) ON DELETE RESTRICT
);
CREATE INDEX pharmacy_win_back_issuances_branch_window_idx
  ON pharmacy_win_back_issuances ("organizationId", "branchId", "campaignWindowStart");

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['pharmacy_win_back_tiers','pharmacy_win_back_category_margins','pharmacy_win_back_previews','pharmacy_win_back_issuances'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY %I ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', t || '_tenant_isolation', t);
END LOOP; END $$;
