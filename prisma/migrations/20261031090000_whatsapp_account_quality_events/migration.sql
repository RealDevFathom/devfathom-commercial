-- Durable account-level WhatsApp hold. Each Meta account_update occurrence is
-- recorded once; an unresolved HOLD row pauses every outbound WhatsApp feed
-- (campaign approval/capture, refill and khata reminders, inbound auto-replies)
-- until Meta reinstates the account or an owner resumes sending.
CREATE TABLE "pharmacy_whatsapp_quality_events" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "eventKey" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "issue" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "resolvedByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_whatsapp_quality_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_whatsapp_quality_events_issue_check" CHECK ("issue" IN ('DISABLED', 'RESTRICTION', 'VIOLATION')),
  CONSTRAINT "pharmacy_whatsapp_quality_events_action_check" CHECK ("action" IN ('HOLD', 'RECOVER')),
  CONSTRAINT "pharmacy_whatsapp_quality_events_resolution_check" CHECK ("resolvedAt" IS NULL OR "action" = 'HOLD')
);

CREATE UNIQUE INDEX "pharmacy_whatsapp_quality_events_organizationId_eventKey_key"
  ON "pharmacy_whatsapp_quality_events"("organizationId", "eventKey");
CREATE INDEX "pharmacy_whatsapp_quality_events_organizationId_resolvedAt_idx"
  ON "pharmacy_whatsapp_quality_events"("organizationId", "resolvedAt");

ALTER TABLE "pharmacy_whatsapp_quality_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_whatsapp_quality_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_whatsapp_quality_events"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );

-- Campaign holds now carry provenance in "holdPreviousStatus" only; the refusal
-- field keeps its single meaning.
UPDATE "pharmacy_campaigns" SET "refusalReason" = NULL
WHERE "status" = 'ACCOUNT_QUALITY_HOLD' AND "refusalReason" = 'WhatsApp account-quality hold';
