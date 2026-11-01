-- Retry scheduling and dead letters for the outbound effect worker.
-- PENDING rows wait until availableAt. Exhausted rows become DEAD and are not claimed.
-- 20261021140000 never landed on integration. The statements stay safe to re-run.
ALTER TABLE "outbound_effects" ADD COLUMN IF NOT EXISTS "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Drop the previous check, then recreate it.
ALTER TABLE "outbound_effects" DROP CONSTRAINT IF EXISTS "outbound_effects_status_check";
ALTER TABLE "outbound_effects" ADD CONSTRAINT "outbound_effects_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD'));

CREATE INDEX IF NOT EXISTS "outbound_effects_status_available_idx" ON "outbound_effects"("status", "availableAt");

-- outbound_effects has FORCE ROW LEVEL SECURITY. The table owner is filtered too,
-- unless this transaction sets the platform-admin flag the policy already allows.
-- The third argument keeps the setting local to this transaction.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Webhook secrets and endpoint URLs are loaded at send time. Drop copies already stored in the outbox.
UPDATE "outbound_effects"
SET payload = payload - 'secret' - 'url'
WHERE kind = 'webhook';

-- New deliveries dead-letter as DEAD. Remove leftover FAILED rows and the personal data they hold.
DELETE FROM "outbound_effects" WHERE status = 'FAILED';

-- Bucket keys are HMAC-SHA256 hex. Raw addresses and emails must not remain.
-- rate_limit_buckets has no row-level security; the setting above does not change this delete.
DELETE FROM "rate_limit_buckets" WHERE key !~ '^[0-9a-f]{64}$';
