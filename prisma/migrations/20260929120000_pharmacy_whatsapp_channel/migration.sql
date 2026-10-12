-- WHA-1622 / PH-B3 — WhatsApp channel: customer consent flag plus the message log.
-- Additive only: two nullable columns and one new tenant-isolated table.
ALTER TABLE "pharmacy_customers"
  ADD COLUMN "whatsappOptIn" BOOLEAN,
  ADD COLUMN "whatsappOptInChangedAt" TIMESTAMP(3);

CREATE TABLE "pharmacy_message_logs" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL DEFAULT current_setting('app.current_organization_id', true),
  "branchId" TEXT,
  "customerId" TEXT,
  "patientId" TEXT,
  "channel" TEXT NOT NULL DEFAULT 'WHATSAPP',
  "direction" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "dedupeKey" TEXT NOT NULL,
  "phoneLast4" TEXT,
  "templateName" TEXT,
  "providerMessageId" TEXT,
  "refillCaptureId" TEXT,
  "orderId" TEXT,
  "dueDate" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pharmacy_message_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_message_logs_channel_check" CHECK ("channel" = 'WHATSAPP'),
  CONSTRAINT "pharmacy_message_logs_direction_check" CHECK ("direction" IN ('OUTBOUND', 'INBOUND')),
  CONSTRAINT "pharmacy_message_logs_kind_check" CHECK ("kind" IN (
    'REFILL_REMINDER', 'ORDER_REQUEST', 'ORDER_CONFIRMATION', 'ORDER_FALLBACK',
    'OPT_OUT', 'OPT_IN', 'CONSENT_ACK'
  )),
  CONSTRAINT "pharmacy_message_logs_status_check" CHECK ("status" IN (
    'PENDING', 'SENT', 'FAILED', 'RECEIVED', 'IGNORED'
  )),
  CONSTRAINT "pharmacy_message_logs_phone_last4_check" CHECK ("phoneLast4" IS NULL OR "phoneLast4" ~ '^\d{4}$'),
  CONSTRAINT "pharmacy_message_logs_due_date_check" CHECK ("dueDate" IS NULL OR "dueDate" ~ '^\d{4}-\d{2}-\d{2}$'),
  CONSTRAINT "pharmacy_message_logs_organization_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_message_logs_branch_fkey" FOREIGN KEY ("organizationId", "branchId") REFERENCES "pharmacy_branches"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_message_logs_customer_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "pharmacy_customers"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "pharmacy_message_logs_dedupe_key" ON "pharmacy_message_logs"("organizationId", "dedupeKey");
CREATE INDEX "pharmacy_message_logs_customer_idx" ON "pharmacy_message_logs"("organizationId", "customerId", "createdAt" DESC);
CREATE INDEX "pharmacy_message_logs_kind_status_idx" ON "pharmacy_message_logs"("organizationId", "kind", "status");

ALTER TABLE "pharmacy_message_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pharmacy_message_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pharmacy_message_logs"
  USING (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  )
  WITH CHECK (
    current_setting('app.is_platform_admin', true) = 'true' OR
    "organizationId" = NULLIF(current_setting('app.current_organization_id', true), '')
  );
