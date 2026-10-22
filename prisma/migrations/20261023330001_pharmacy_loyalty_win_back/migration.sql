ALTER TABLE pharmacy_loyalty_settings
  ADD COLUMN "winBackEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "winBackInactivityDays" INTEGER NOT NULL DEFAULT 45 CHECK ("winBackInactivityDays" BETWEEN 1 AND 3650),
  ADD COLUMN "winBackWindowDays" INTEGER NOT NULL DEFAULT 30 CHECK ("winBackWindowDays" BETWEEN 1 AND 365),
  ADD COLUMN "winBackMinimumSpendMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("winBackMinimumSpendMinor" >= 0),
  ADD COLUMN "winBackMinNextBasketMinor" INTEGER NOT NULL DEFAULT 0 CHECK ("winBackMinNextBasketMinor" >= 0),
  ADD COLUMN "winBackDefaultMarginBasisPoints" INTEGER NOT NULL DEFAULT 1450 CHECK ("winBackDefaultMarginBasisPoints" BETWEEN 0 AND 10000),
  ADD COLUMN "winBackRedemptionBasisPoints" INTEGER NOT NULL DEFAULT 2500 CHECK ("winBackRedemptionBasisPoints" BETWEEN 0 AND 10000),
  ADD COLUMN "winBackEnabledPreviewId" TEXT,
  ADD COLUMN "winBackEnabledPreviewHash" TEXT;

CREATE TABLE pharmacy_win_back_tiers (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "minimumSpendMinor" INTEGER NOT NULL CHECK ("minimumSpendMinor" >= 0), "maximumSpendMinor" INTEGER CHECK ("maximumSpendMinor" >= "minimumSpendMinor"),
  "voucherValueMinor" INTEGER NOT NULL CHECK ("voucherValueMinor" BETWEEN 20000 AND 100000), position INTEGER NOT NULL CHECK (position >= 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id), UNIQUE ("organizationId", position)
);
CREATE TABLE pharmacy_win_back_category_margins (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "categoryId" TEXT NOT NULL,
  "marginBasisPoints" INTEGER NOT NULL DEFAULT 1450 CHECK ("marginBasisPoints" BETWEEN 0 AND 10000),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id), UNIQUE ("organizationId", "categoryId")
);
CREATE TABLE pharmacy_win_back_previews (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "settingsHash" TEXT NOT NULL,
  "eligibleCustomerCount" INTEGER NOT NULL, "totalVoucherLiabilityMinor" INTEGER NOT NULL, "expectedRedemptions" INTEGER NOT NULL,
  "expectedVoucherCostMinor" INTEGER NOT NULL, "expectedMarginMinor" INTEGER NOT NULL, "netMarginImpactMinor" INTEGER NOT NULL,
  "redemptionBasisPoints" INTEGER NOT NULL, "generatedByActorId" TEXT NOT NULL, "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id)
);
CREATE INDEX pharmacy_win_back_previews_generated_idx ON pharmacy_win_back_previews ("organizationId", "generatedAt");
CREATE TABLE pharmacy_win_back_issuances (
  id TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true), "customerId" TEXT NOT NULL,
  "voucherId" TEXT NOT NULL, "campaignWindowStart" TIMESTAMP(3) NOT NULL, "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("organizationId", id), UNIQUE ("organizationId", "customerId", "campaignWindowStart"), UNIQUE ("organizationId", "voucherId")
);

DO $$ DECLARE t TEXT; BEGIN FOREACH t IN ARRAY ARRAY['pharmacy_win_back_tiers','pharmacy_win_back_category_margins','pharmacy_win_back_previews','pharmacy_win_back_issuances'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY %I ON %I USING ("organizationId" = current_setting(''app.current_organization_id'', true)) WITH CHECK ("organizationId" = current_setting(''app.current_organization_id'', true))', t || '_tenant_isolation', t);
END LOOP; END $$;
