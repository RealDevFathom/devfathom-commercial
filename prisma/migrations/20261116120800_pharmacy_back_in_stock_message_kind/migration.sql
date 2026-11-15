-- DEV-79: the back-in-stock utility notice is logged with its own message kind.
-- Keeps every kind allowed before it, including DEV-16 RECEIPT_LINK.
-- Only the kind CHECK changes; RLS policies on the table remain intact.
BEGIN;

ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT IF EXISTS "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_READY', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK', 'RECEIPT_LINK', 'BACK_IN_STOCK'
  ));

COMMIT;
