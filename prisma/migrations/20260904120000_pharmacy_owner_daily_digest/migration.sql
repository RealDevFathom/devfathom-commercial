ALTER TYPE "PlatformJobType" ADD VALUE 'DAILY_OWNER_DIGEST';

CREATE TABLE "pharmacy_owner_digest_settings" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "enabled" BOOLEAN NOT NULL DEFAULT false, "localTime" TEXT NOT NULL DEFAULT '08:00',
  "channel" TEXT NOT NULL DEFAULT 'CAPTURE', "configuredByUserId" TEXT NOT NULL,
  "lastEnqueuedDate" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_owner_digest_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_owner_digest_settings_organizationId_key" UNIQUE ("organizationId"),
  CONSTRAINT "pharmacy_owner_digest_settings_local_time_check" CHECK ("localTime" ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT "pharmacy_owner_digest_settings_channel_check" CHECK ("channel" IN ('CAPTURE', 'WHATSAPP')),
  CONSTRAINT "pharmacy_owner_digest_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_owner_digest_settings_configuredByUserId_fkey" FOREIGN KEY ("configuredByUserId") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE TABLE "pharmacy_owner_digests" (
  "id" TEXT NOT NULL, "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL, "businessDate" TEXT NOT NULL, "channel" TEXT NOT NULL,
  "deliveryStatus" TEXT NOT NULL, "rendered" TEXT NOT NULL, "metrics" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_owner_digests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_owner_digests_org_branch_date_channel_key" UNIQUE ("organizationId", "branchId", "businessDate", "channel"),
  CONSTRAINT "pharmacy_owner_digests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE,
  CONSTRAINT "pharmacy_owner_digests_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE CASCADE
);
CREATE INDEX "pharmacy_owner_digests_org_created_idx" ON "pharmacy_owner_digests"("organizationId", "createdAt");
CREATE INDEX "pharmacy_owner_digests_org_branch_created_idx" ON "pharmacy_owner_digests"("organizationId", "branchId", "createdAt");

ALTER TABLE "pharmacy_owner_digest_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_owner_digest_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_owner_digest_settings_tenant" ON "pharmacy_owner_digest_settings"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
ALTER TABLE "pharmacy_owner_digests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_owner_digests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pharmacy_owner_digests_tenant" ON "pharmacy_owner_digests"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
