-- Nullable for existing logs and other message kinds. RLS policies remain intact.
ALTER TABLE "pharmacy_message_logs" ADD COLUMN "customerDayKey" TEXT;
CREATE UNIQUE INDEX "pharmacy_message_logs_customer_day_key"
  ON "pharmacy_message_logs" ("organizationId", "customerDayKey");

-- Statement balances include account-level credits without a charge allocation.
-- Keep the scoped charge FK for allocated payments and every other shape guard.
ALTER TABLE "pharmacy_khata_events" DROP CONSTRAINT "pharmacy_khata_events_shape_check";
ALTER TABLE "pharmacy_khata_events" ADD CONSTRAINT "pharmacy_khata_events_shape_check" CHECK (
  ("kind" = 'CHARGE' AND "memberId" IS NOT NULL AND "dueAt" IS NOT NULL AND "settlesChargeId" IS NULL) OR
  ("kind" = 'PAYMENT' AND "memberId" IS NULL AND "dueAt" IS NULL) OR
  ("kind" = 'DISHONOURED_CHEQUE' AND "memberId" IS NULL AND "dueAt" IS NULL)
);

-- The original WhatsApp kind guard predates the khata utility template.
ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK'
  ));
