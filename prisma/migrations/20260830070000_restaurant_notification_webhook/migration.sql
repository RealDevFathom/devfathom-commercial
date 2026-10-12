-- WHA-910: tenant-configured, signed Restaurant SOP webhook delivery.
ALTER TYPE "RestaurantNotificationChannel" ADD VALUE 'WEBHOOK' AFTER 'IN_APP';
ALTER TYPE "RestaurantNotificationDeliveryStatus" ADD VALUE 'DELIVERED_WEBHOOK' AFTER 'DELIVERED_IN_APP';

CREATE TABLE "restaurant_notification_webhooks" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "endpointUrl" TEXT NOT NULL,
  "encryptedSigningSecret" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "lastSuccessAt" TIMESTAMP(3),
  "lastFailureAt" TIMESTAMP(3),
  "lastFailure" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "restaurant_notification_webhooks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "restaurant_notification_webhooks_endpoint_ck" CHECK (length("endpointUrl") BETWEEN 1 AND 2048),
  CONSTRAINT "restaurant_notification_webhooks_secret_ck" CHECK (length("encryptedSigningSecret") > 0),
  CONSTRAINT "restaurant_notification_webhooks_failure_ck" CHECK ("lastFailure" IS NULL OR length("lastFailure") <= 500)
);

CREATE UNIQUE INDEX "restaurant_notification_webhooks_organizationId_key"
  ON "restaurant_notification_webhooks"("organizationId");
CREATE INDEX "restaurant_notification_webhooks_organizationId_idx"
  ON "restaurant_notification_webhooks"("organizationId");

ALTER TABLE "restaurant_notification_webhooks"
  ADD CONSTRAINT "restaurant_notification_webhooks_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "restaurant_notification_webhooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "restaurant_notification_webhooks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "restaurant_notification_webhooks"
  USING (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''))
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true' OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), ''));
