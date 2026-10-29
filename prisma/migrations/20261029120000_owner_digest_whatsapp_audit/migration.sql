-- RPT-03 — audit owner briefing deliveries in the existing tenant-isolated
-- WhatsApp message log. Replacing the enum-like CHECK is safe for non-empty
-- databases because every previously accepted kind remains accepted.
ALTER TABLE "pharmacy_message_logs" DROP CONSTRAINT "pharmacy_message_logs_kind_check";
ALTER TABLE "pharmacy_message_logs" ADD CONSTRAINT "pharmacy_message_logs_kind_check"
  CHECK ("kind" IN (
    'REFILL_REMINDER', 'KHATA_REMINDER', 'OWNER_DIGEST', 'ORDER_REQUEST',
    'ORDER_CONFIRMATION', 'ORDER_FALLBACK', 'OPT_OUT', 'OPT_IN', 'CONSENT_ACK'
  ));
