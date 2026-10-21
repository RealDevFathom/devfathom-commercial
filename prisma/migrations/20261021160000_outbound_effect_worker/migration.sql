-- Retry scheduling and dead letters for the outbound effect worker.
-- PENDING rows wait until availableAt. Exhausted rows become DEAD and are not claimed.
ALTER TABLE "outbound_effects" ADD COLUMN "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "outbound_effects" DROP CONSTRAINT "outbound_effects_status_check";
ALTER TABLE "outbound_effects" ADD CONSTRAINT "outbound_effects_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD'));

CREATE INDEX "outbound_effects_status_available_idx" ON "outbound_effects"("status", "availableAt");

-- Webhook secrets and endpoint URLs are loaded at send time. Drop copies already stored in the outbox.
UPDATE "outbound_effects"
SET payload = payload - 'secret' - 'url'
WHERE kind = 'webhook';

-- New deliveries dead-letter as DEAD. Remove leftover FAILED rows and the personal data they hold.
DELETE FROM "outbound_effects" WHERE status = 'FAILED';

-- Bucket keys are HMAC-SHA256 hex. Raw addresses and emails must not remain.
DELETE FROM "rate_limit_buckets" WHERE key !~ '^[0-9a-f]{64}$';
