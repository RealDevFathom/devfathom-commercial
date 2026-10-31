-- Receipt authorization and its encrypted delivery intent commit together.
-- Preserve both existing outbox kinds and their delivery workers.
ALTER TABLE "outbound_effects" DROP CONSTRAINT "outbound_effects_kind_check";
ALTER TABLE "outbound_effects" ADD CONSTRAINT "outbound_effects_kind_check"
  CHECK ("kind" IN ('email', 'webhook', 'pharmacy-hosted-receipt'));
