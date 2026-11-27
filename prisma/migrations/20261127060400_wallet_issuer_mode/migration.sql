BEGIN;
SET LOCAL lock_timeout = '5s';
-- NULL identifies existing restaurant passes using their established issuer path.
ALTER TABLE restaurant_wallet_passes ADD COLUMN IF NOT EXISTS "issuerMode" text
 CHECK ("issuerMode" IN ('TEST','DEMO','LIVE'));
COMMIT;
