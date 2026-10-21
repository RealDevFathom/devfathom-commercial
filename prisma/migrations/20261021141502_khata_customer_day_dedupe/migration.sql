-- Nullable for existing logs and other message kinds. RLS policies remain intact.
ALTER TABLE "pharmacy_message_logs" ADD COLUMN "customerDayKey" TEXT;
CREATE UNIQUE INDEX "pharmacy_message_logs_customer_day_key"
  ON "pharmacy_message_logs" ("organizationId", "customerDayKey");

-- The original WhatsApp kind guard predates the khata utility template.
ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK'
  ));
