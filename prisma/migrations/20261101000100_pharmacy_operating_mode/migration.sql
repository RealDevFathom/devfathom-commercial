BEGIN;

DO $$ BEGIN
  CREATE TYPE "PharmacyOperatingMode" AS ENUM ('SOLO', 'STAFFED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS "pharmacyOperatingMode" "PharmacyOperatingMode" NOT NULL DEFAULT 'STAFFED';

-- SOLO is an explicit organization policy checked IN ADDITION to the #683
-- singleton-owner rule. Do not redefine pharmacy_solo_owner_eligible here: this
-- migration sorts after every #683 migration, and replacing that function would
-- silently drop its "exactly one active user" requirement in environments that
-- deploy #683 first. The application (soloOwnerEligible) and the
-- pharmacy_solo_mode_audit triggers in the next migration enforce SOLO mode.

COMMIT;
