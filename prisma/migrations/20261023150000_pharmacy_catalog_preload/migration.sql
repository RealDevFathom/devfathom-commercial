ALTER TYPE "PlatformJobType" ADD VALUE 'pharmacy.catalog.seed.v1';
CREATE TYPE "CatalogSeedRunStatus" AS ENUM ('RUNNING', 'COMPLETED');

ALTER TABLE "pharmacy_pack_levels"
  ADD COLUMN "catalogDefaultSalePriceMinor" INTEGER,
  ADD COLUMN "catalogDefaultPurchasePriceMinor" INTEGER,
  ADD COLUMN "sellingPriceMinor" INTEGER,
  ADD COLUMN "purchasePriceMinor" INTEGER;

-- This high-impact setting is intentionally outside pharmacy:* and belongs only
-- to the system Owner template. Preserve an existing explicit DENY.
SELECT set_config('app.is_platform_admin', 'true', true);
INSERT INTO organization_role_permissions
  (id, "organizationId", "organizationRoleId", capability, effect, "createdAt")
SELECT 'cat_settings_' || md5(r.id), r."organizationId", r.id,
       'pharmacy:catalog-settings', 'ALLOW'::"PermissionEffect", now()
FROM organization_roles r
WHERE r.key = 'owner' AND r."isSystem" = true
ON CONFLICT ("organizationRoleId", capability) DO NOTHING;

CREATE TABLE "pharmacy_catalog_seed_runs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "catalogVersion" TEXT NOT NULL,
  "status" "CatalogSeedRunStatus" NOT NULL DEFAULT 'RUNNING',
  "expectedCount" INTEGER NOT NULL,
  "createdCount" INTEGER NOT NULL DEFAULT 0,
  "completedAt" TIMESTAMP(3),
  "requestedById" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_catalog_seed_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_catalog_seed_runs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "pharmacy_catalog_seed_runs_organizationId_catalogVersion_key" ON "pharmacy_catalog_seed_runs"("organizationId", "catalogVersion");
CREATE INDEX "pharmacy_catalog_seed_runs_organizationId_status_idx" ON "pharmacy_catalog_seed_runs"("organizationId", "status");

CREATE TABLE "pharmacy_catalog_settings" (
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "useCatalogDefaultPrices" BOOLEAN NOT NULL DEFAULT false,
  "enabledById" TEXT,
  "enabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_catalog_settings_pkey" PRIMARY KEY ("organizationId"),
  CONSTRAINT "pharmacy_catalog_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE
);

ALTER TABLE "pharmacy_catalog_seed_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_catalog_seed_runs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_catalog_seed_runs" USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "pharmacy_catalog_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_catalog_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "pharmacy_catalog_settings" USING ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK ("organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));

ALTER TABLE "pharmacy_pack_levels" ADD CONSTRAINT "pharmacy_pack_levels_catalog_prices_ck" CHECK (
  ("catalogDefaultSalePriceMinor" IS NULL OR "catalogDefaultSalePriceMinor" >= 0) AND
  ("catalogDefaultPurchasePriceMinor" IS NULL OR "catalogDefaultPurchasePriceMinor" >= 0) AND
  ("sellingPriceMinor" IS NULL OR "sellingPriceMinor" >= 0) AND
  ("purchasePriceMinor" IS NULL OR "purchasePriceMinor" >= 0)
) NOT VALID;
