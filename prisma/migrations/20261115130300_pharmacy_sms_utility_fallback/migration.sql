-- DEV-87: SMS is the utility fallback channel for refill-due, order-ready and
-- khata-due messages, and inbound SMS STOP/START are logged in the same table.
-- Only the CHECK guards change; RLS policies on the table remain intact.
BEGIN;

ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT IF EXISTS "pharmacy_message_logs_channel_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_channel_check"
  CHECK ("channel" IN ('WHATSAPP', 'SMS'));

ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT IF EXISTS "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_READY', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK'
  ));

COMMIT;
