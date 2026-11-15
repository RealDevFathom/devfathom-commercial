-- DEV-22: WhatsApp strike and account-quality monitor. Stores signed Meta
-- account_update / phone_number_quality_update evidence per tenant; the latest
-- row feeds the marketing auto-pause. Idempotent and tenant-isolated.
BEGIN;

CREATE TABLE IF NOT EXISTS "pharmacy_whatsapp_account_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "businessAccountId" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "severity" TEXT NOT NULL,
  "detail" TEXT,
  "restrictedUntil" TIMESTAMP(3),
  "eventKey" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_whatsapp_account_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_whatsapp_account_events_field_check"
    CHECK ("field" IN ('account_update', 'phone_number_quality_update')),
  CONSTRAINT "pharmacy_whatsapp_account_events_severity_check"
    CHECK ("severity" IN ('INFO', 'WARNING', 'BLOCK', 'CLEARED')),
  CONSTRAINT "pharmacy_whatsapp_account_events_organization_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_whatsapp_account_events_event_key"
  ON "pharmacy_whatsapp_account_events"("organizationId", "eventKey");
CREATE INDEX IF NOT EXISTS "pharmacy_whatsapp_account_events_recent_idx"
  ON "pharmacy_whatsapp_account_events"("organizationId", "occurredAt" DESC);

-- Provider evidence is never rewritten; tenant deletion still cascades.
DROP TRIGGER IF EXISTS "pharmacy_whatsapp_account_events_immutable" ON "pharmacy_whatsapp_account_events";
CREATE TRIGGER "pharmacy_whatsapp_account_events_immutable"
  BEFORE UPDATE ON "pharmacy_whatsapp_account_events"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_reject_append_only_change();

ALTER TABLE "pharmacy_whatsapp_account_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_whatsapp_account_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "pharmacy_whatsapp_account_events";
CREATE POLICY tenant_isolation ON "pharmacy_whatsapp_account_events"
  USING (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true'
    OR "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

COMMIT;
