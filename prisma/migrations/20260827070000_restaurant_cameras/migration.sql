CREATE TABLE "restaurant_camera_gateways" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "gatewaySecretHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "revokedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "baseUrl" TEXT NOT NULL,
  "retentionDays" INTEGER NOT NULL DEFAULT 7,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "restaurant_camera_gateways_gatewaySecretHash_key" ON "restaurant_camera_gateways"("gatewaySecretHash");
CREATE INDEX "restaurant_camera_gateways_organizationId_branchId_idx" ON "restaurant_camera_gateways"("organizationId", "branchId");

CREATE TABLE "restaurant_camera_credentials" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "sealedValue" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "rotatedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "restaurant_camera_credentials_organizationId_idx" ON "restaurant_camera_credentials"("organizationId");

CREATE TABLE "restaurant_cameras" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "gatewayId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "credentialId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "restaurant_cameras_organizationId_branchId_idx" ON "restaurant_cameras"("organizationId", "branchId");
CREATE INDEX "restaurant_cameras_gatewayId_idx" ON "restaurant_cameras"("gatewayId");

CREATE TABLE "restaurant_camera_stream_grants" (
  "id" TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "cameraId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "restaurant_camera_stream_grants_organizationId_cameraId_viewerId_idx" ON "restaurant_camera_stream_grants"("organizationId", "cameraId", "viewerId");
CREATE INDEX "restaurant_camera_stream_grants_expiresAt_idx" ON "restaurant_camera_stream_grants"("expiresAt");

CREATE TABLE "platform_camera_brand_presets" (
  "id" TEXT PRIMARY KEY,
  "key" TEXT NOT NULL,
  "familyName" TEXT NOT NULL,
  "aliases" TEXT[],
  "iconKey" TEXT NOT NULL,
  "rtspPort" INTEGER NOT NULL DEFAULT 554,
  "onvifPort" INTEGER NOT NULL DEFAULT 80,
  "mainStreamPathTemplate" TEXT NOT NULL,
  "subStreamPathTemplate" TEXT NOT NULL,
  "authSchemeHint" TEXT NOT NULL,
  "defaultUsernameHint" TEXT,
  "credentialNote" TEXT NOT NULL,
  "setupNote" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "platform_camera_brand_presets_key_key" ON "platform_camera_brand_presets"("key");
CREATE INDEX "platform_camera_brand_presets_active_sortOrder_idx" ON "platform_camera_brand_presets"("active", "sortOrder");

DO $$ DECLARE camera_table TEXT; BEGIN
  FOREACH camera_table IN ARRAY ARRAY['restaurant_camera_gateways','restaurant_camera_credentials','restaurant_cameras','restaurant_camera_stream_grants'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', camera_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', camera_table);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), '''')) WITH CHECK (current_setting(''app.is_platform_admin'', true) = ''true'' OR "organizationId" = NULLIF(current_setting(''app.current_organization_id'', true), ''''))', camera_table);
  END LOOP;
END $$;

ALTER TABLE "platform_camera_brand_presets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_camera_brand_presets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "control_plane_only" ON "platform_camera_brand_presets"
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
