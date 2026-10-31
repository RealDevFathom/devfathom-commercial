-- #723 — SMS fallback for pharmacy utility messages.
-- Additive only: two nullable customer columns (SMS STOP/START flag) and wider
-- CHECK guards on the existing message log. RLS policies remain intact.
ALTER TABLE "pharmacy_customers"
  ADD COLUMN "smsOptIn" BOOLEAN,
  ADD COLUMN "smsOptInChangedAt" TIMESTAMP(3);

ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_channel_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_channel_check"
  CHECK ("channel" IN ('WHATSAPP', 'SMS'));

ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'ORDER_READY', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK'
  ));
