-- #720: the owner-only licence renewal utility template is logged as its own
-- WhatsApp kind. Forward-only widening of the kind guard; every existing kind
-- stays permitted and RLS policies remain intact.
ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'ORDER_REQUEST', 'ORDER_CONFIRMATION',
    'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK', 'LICENCE_RENEWAL_REMINDER'
  ));
