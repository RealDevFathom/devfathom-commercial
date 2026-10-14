-- Enrollment-only derivative; existing address-based printer routing is unchanged.
ALTER TYPE "RestaurantDeviceKind" ADD VALUE 'PRINT_BRIDGE';
CREATE TABLE "restaurant_print_bridge_enrollment_codes" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "deviceId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "issuedDeviceSecretHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "restaurant_print_bridge_enrollment_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_print_bridge_enrollment_codes_device_fkey" FOREIGN KEY ("organizationId", "deviceId") REFERENCES "restaurant_registered_devices"("organizationId", "id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "restaurant_print_bridge_enrollment_codes_codeHash_key" ON "restaurant_print_bridge_enrollment_codes"("codeHash");
CREATE INDEX "restaurant_print_bridge_enrollment_codes_org_device_idx" ON "restaurant_print_bridge_enrollment_codes"("organizationId", "deviceId");
ALTER TABLE "restaurant_print_bridge_enrollment_codes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_print_bridge_enrollment_codes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_print_bridge_enrollment_codes" USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')) WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
