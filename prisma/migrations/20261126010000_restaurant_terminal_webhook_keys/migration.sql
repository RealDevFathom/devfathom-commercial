BEGIN;
SET LOCAL lock_timeout = '10s';

-- Freeze a single deadline at deployment. A configuration created later inherits
-- the same absolute instant, even after a restart or the end of the changeover.
DO $migration$
BEGIN
  EXECUTE format(
    'ALTER TABLE public.restaurant_terminal_provider_configs
       ADD COLUMN IF NOT EXISTS "encryptedSigningSecret" text,
       ADD COLUMN IF NOT EXISTS "previousEncryptedSigningSecret" text,
       ADD COLUMN IF NOT EXISTS "previousSigningSecretExpiresAt" timestamptz(3),
       ADD COLUMN IF NOT EXISTS "legacySigningCutoff" timestamptz(3) NOT NULL DEFAULT %L::timestamptz',
    transaction_timestamp() + interval '720 hours'
  );

  IF NOT EXISTS (
    SELECT FROM pg_constraint
    WHERE conrelid = 'public.restaurant_terminal_provider_configs'::regclass
      AND conname = 'restaurant_terminal_previous_key_pair'
  ) THEN
    ALTER TABLE public.restaurant_terminal_provider_configs
      ADD CONSTRAINT restaurant_terminal_previous_key_pair CHECK (
        ("previousEncryptedSigningSecret" IS NULL) = ("previousSigningSecretExpiresAt" IS NULL)
        AND ("previousEncryptedSigningSecret" IS NULL OR "encryptedSigningSecret" IS NOT NULL)
      );
  END IF;
END
$migration$;

-- Retirement survives disabling or deleting the config that first adopted a key.
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS
  "restaurantRetiredWebhookSources" text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.restaurant_retire_shared_webhook_key()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('restaurant:webhook:' || NEW."organizationId", 0));
  UPDATE public.organizations
     SET "restaurantRetiredWebhookSources" = array_append("restaurantRetiredWebhookSources", NEW.source)
   WHERE id = NEW."organizationId" AND NOT (NEW.source = ANY("restaurantRetiredWebhookSources"));
  RETURN NEW;
END
$$;
CREATE OR REPLACE TRIGGER restaurant_retire_shared_webhook_key
  AFTER INSERT OR UPDATE OF "encryptedSigningSecret", source ON public.restaurant_terminal_provider_configs
  FOR EACH ROW WHEN (NEW."encryptedSigningSecret" IS NOT NULL)
  EXECUTE FUNCTION public.restaurant_retire_shared_webhook_key();

SET LOCAL app.is_platform_admin = 'true';
UPDATE public.organizations AS org
SET "restaurantRetiredWebhookSources" = ARRAY(
  SELECT unnest(org."restaurantRetiredWebhookSources")
  UNION
  SELECT source FROM public.restaurant_terminal_provider_configs
  WHERE "organizationId" = org.id AND "encryptedSigningSecret" IS NOT NULL
)
WHERE EXISTS (
  SELECT FROM public.restaurant_terminal_provider_configs
  WHERE "organizationId" = org.id AND "encryptedSigningSecret" IS NOT NULL
    AND NOT (source = ANY(org."restaurantRetiredWebhookSources"))
);

COMMIT;
