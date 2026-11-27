BEGIN;
SET LOCAL lock_timeout = '5s';
-- Existing restaurant designs already authorize enrollment. Preserve those rows once.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='restaurant_wallet_tenant_config'::regclass AND attname='enabled' AND NOT attisdropped) THEN
    ALTER TABLE restaurant_wallet_tenant_config ADD COLUMN enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE restaurant_wallet_tenant_config ALTER COLUMN enabled SET DEFAULT false;
  END IF;
END $$;
ALTER TABLE restaurant_wallet_tenant_config ADD COLUMN IF NOT EXISTS "logoPng" bytea;
ALTER TABLE restaurant_wallet_tenant_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE restaurant_wallet_tenant_config FORCE ROW LEVEL SECURITY;
COMMIT;
