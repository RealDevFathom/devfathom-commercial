-- Per-organization Meta WhatsApp sender credentials. There is intentionally
-- no plaintext token column and phone_number_id is globally unique so routing
-- can never become ambiguous across tenants.
CREATE TABLE "pharmacy_whatsapp_connections" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "phoneNumberId" TEXT NOT NULL,
  "wabaId" TEXT,
  "encryptedAccessToken" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_whatsapp_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_whatsapp_connections_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_whatsapp_connections_phone_number_id_check"
    CHECK ("phoneNumberId" ~ '^[0-9]{5,32}$')
);

CREATE UNIQUE INDEX "pharmacy_whatsapp_connections_organization_key"
  ON "pharmacy_whatsapp_connections"("organizationId");
CREATE UNIQUE INDEX "pharmacy_whatsapp_connections_phone_number_key"
  ON "pharmacy_whatsapp_connections"("phoneNumberId");
CREATE INDEX "pharmacy_whatsapp_connections_enabled_idx"
  ON "pharmacy_whatsapp_connections"("organizationId", "enabled");

ALTER TABLE "pharmacy_whatsapp_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_whatsapp_connections" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_whatsapp_connections"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
