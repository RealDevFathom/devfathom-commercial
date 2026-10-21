BEGIN;
SELECT set_config('app.is_platform_admin', 'true', true);
-- Consent proof expires one year after archival. Preserve existing FORCE RLS.
ALTER TABLE growth_wa_consent_retention ADD COLUMN IF NOT EXISTS "expiresAt" timestamptz;
UPDATE growth_wa_consent_retention
SET "expiresAt" = "retainedAt" + interval '365 days'
WHERE "expiresAt" IS NULL;
ALTER TABLE growth_wa_consent_retention ALTER COLUMN "expiresAt" SET DEFAULT (now() + interval '365 days');
ALTER TABLE growth_wa_consent_retention ALTER COLUMN "expiresAt" SET NOT NULL;
CREATE INDEX IF NOT EXISTS growth_wa_consent_retention_expiry ON growth_wa_consent_retention ("expiresAt");
-- Minimize in place: archived tenants may already be purged, so proof cannot
-- be reconstructed from live tenant tables. Keep identifiers and consent dates.
-- The same migration was briefly shipped as 20261022000000. Do not minimize
-- its already-minimized JSON a second time: customer keywords cannot be
-- reconstructed after the first pass removed optInAt/optOutAt.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE migration_name LIKE '20261022000000%'
  ) THEN
    UPDATE growth_wa_consent_retention
    SET evidence = jsonb_strip_nulls(jsonb_build_object(
      'id', COALESCE(evidence->'id', to_jsonb("sourceId")),
      'phone', evidence->'phone',
      'waMessageId', evidence->'waMessageId',
      'customerId', evidence->'customerId',
      'timestamp', COALESCE(evidence->'timestamp', evidence->'optInAt', evidence->'createdAt'),
      'optOutAt', evidence->'optOutAt',
      'keyword', to_jsonb(CASE
        WHEN "evidenceKind" = 'customer' AND evidence->>'optInAt' IS NOT NULL THEN 'opt-in'
        WHEN "evidenceKind" = 'customer' AND evidence->>'optOutAt' IS NOT NULL THEN 'opt-out'
        WHEN lower(trim(COALESCE(evidence->>'body', evidence->>'keyword'))) ~ '^(stop|unsubscribe|band[[:space:]]*karo|band[[:space:]]*kar[[:space:]]*do|ruk[[:space:]]*jaa?o|بند|رک[[:space:]]*جاؤ)([^[:alnum:]]|$)' THEN 'STOP'
        WHEN lower(trim(COALESCE(evidence->>'body', evidence->>'keyword'))) IN ('start', 'شروع') THEN 'START'
        ELSE NULL END)
    ));
  END IF;
END $$;

COMMIT;
