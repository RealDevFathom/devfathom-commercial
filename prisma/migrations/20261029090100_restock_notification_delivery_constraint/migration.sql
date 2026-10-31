-- Keep cancellation evidence mandatory while admitting the delivery states
-- introduced by the preceding migration. Compare as text so enum additions
-- do not depend on the migration runner's transaction boundaries.
ALTER TABLE "pharmacy_restock_notifications"
  DROP CONSTRAINT "pharmacy_restock_notification_cancel_ck";
ALTER TABLE "pharmacy_restock_notifications"
  ADD CONSTRAINT "pharmacy_restock_notification_cancel_ck" CHECK (
    ("status"::text IN ('CAPTURED', 'PROCESSING', 'SENT', 'FAILED') AND "cancelledAt" IS NULL)
    OR ("status"::text = 'CANCELLED' AND "cancelledAt" IS NOT NULL)
  );

-- Restock sends share the existing committed outbox and its scheduled drainer.
ALTER TABLE "outbound_effects" DROP CONSTRAINT "outbound_effects_kind_check";
ALTER TABLE "outbound_effects" ADD CONSTRAINT "outbound_effects_kind_check"
  CHECK ("kind" IN ('email', 'webhook', 'pharmacy-back-in-stock'));
