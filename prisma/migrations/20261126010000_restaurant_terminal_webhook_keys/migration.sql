BEGIN;
SET LOCAL lock_timeout = '10s';

-- Freeze a single deadline at deployment. A configuration created later inherits
-- the same absolute instant, even after a restart or the end of the changeover.
DO $migration$
BEGIN
  EXECUTE format(
    'ALTER TABLE public.restaurant_terminal_provider_configs
       ADD COLUMN "encryptedSigningSecret" text,
       ADD COLUMN "previousEncryptedSigningSecret" text,
       ADD COLUMN "previousSigningSecretExpiresAt" timestamptz(3),
       ADD COLUMN "legacySigningCutoff" timestamptz(3) NOT NULL DEFAULT %L::timestamptz,
       ADD CONSTRAINT restaurant_terminal_previous_key_pair CHECK (
         ("previousEncryptedSigningSecret" IS NULL) = ("previousSigningSecretExpiresAt" IS NULL)
         AND ("previousEncryptedSigningSecret" IS NULL OR "encryptedSigningSecret" IS NOT NULL)
       )',
    transaction_timestamp() + interval '720 hours'
  );
END
$migration$;

COMMIT;
