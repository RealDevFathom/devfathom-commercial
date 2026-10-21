-- Replay data changes from 20261021160000_outbound_effect_worker (#218).
-- Explicit transaction keeps platform scope alive across statements.
-- Original migrations remain immutable; predicates/conflict handling permit replay.
BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);

UPDATE "outbound_effects"
SET payload = (payload - 'secret' - 'url') #- '{meta,secret}'
WHERE kind = 'webhook'
  AND payload IS DISTINCT FROM ((payload - 'secret' - 'url') #- '{meta,secret}');

-- New deliveries dead-letter as DEAD. Remove leftover FAILED rows and the personal data they hold.
DELETE FROM "outbound_effects" WHERE status = 'FAILED';

-- Bucket keys are HMAC-SHA256 hex. Raw addresses and emails must not remain.
-- rate_limit_buckets has no row-level security; the setting above does not change this delete.
DELETE FROM "rate_limit_buckets" WHERE key !~ '^[0-9a-f]{64}$';

COMMIT;
