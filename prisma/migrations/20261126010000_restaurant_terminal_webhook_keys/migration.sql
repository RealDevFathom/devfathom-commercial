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

COMMIT;
