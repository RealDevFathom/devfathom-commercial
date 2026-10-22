-- #604: a printed expiry ends at 00:00 in the organization's timezone, not at UTC
-- midnight (06/2027 in Asia/Karachi expires at 2027-06-30 19:00 UTC). Code before this
-- release stored the UTC-midnight boundary, so expired stock stayed saleable for up to
-- the zone offset (five hours in Pakistan).
--
-- Two parts, both idempotent:
-- 1. A BEFORE INSERT/UPDATE trigger on batches and lots turns any UTC-midnight boundary
--    into local midnight. This closes the rollout race: the previous web task keeps
--    serving while this migration runs, and anything it writes is normalized on write.
-- 2. A backfill of every existing batch and lot through the same rule.
-- Only a value at exactly 00:00 UTC is changed; a converted value (19:00 for Karachi) is
-- left alone, so re-running either part changes nothing. A UTC organization is a no-op.

CREATE OR REPLACE FUNCTION pharmacy_local_expiry_boundary(boundary TIMESTAMP(3), organization_id TEXT)
RETURNS TIMESTAMP(3)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  zone TEXT;
BEGIN
  IF boundary IS NULL OR boundary <> date_trunc('day', boundary) THEN
    RETURN boundary;
  END IF;
  SELECT o."timezone" INTO zone FROM "organizations" o WHERE o."id" = organization_id;
  IF zone IS NULL OR zone = '' THEN
    RETURN boundary;
  END IF;
  BEGIN
    -- The naive value is read as local wall time in the zone, then stored as UTC.
    RETURN ((boundary AT TIME ZONE zone) AT TIME ZONE 'UTC')::TIMESTAMP(3);
  EXCEPTION WHEN invalid_parameter_value THEN
    -- An unknown zone falls back to UTC, as workspaceTimezone() does in code.
    RETURN boundary;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION pharmacy_normalize_batch_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."expiresAt" := pharmacy_local_expiry_boundary(NEW."expiresAt", NEW."organizationId");
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION pharmacy_normalize_lot_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."receivedExpiresAt" := pharmacy_local_expiry_boundary(NEW."receivedExpiresAt", NEW."organizationId");
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pharmacy_manufacturing_batches_local_expiry ON "pharmacy_manufacturing_batches";
CREATE TRIGGER pharmacy_manufacturing_batches_local_expiry
BEFORE INSERT OR UPDATE OF "expiresAt" ON "pharmacy_manufacturing_batches"
FOR EACH ROW EXECUTE FUNCTION pharmacy_normalize_batch_expiry();

DROP TRIGGER IF EXISTS pharmacy_inventory_lots_local_expiry ON "pharmacy_inventory_lots";
CREATE TRIGGER pharmacy_inventory_lots_local_expiry
BEFORE INSERT OR UPDATE OF "receivedExpiresAt" ON "pharmacy_inventory_lots"
FOR EACH ROW EXECUTE FUNCTION pharmacy_normalize_lot_expiry();

-- Transaction-local platform context reads every tenant's timezone under FORCE RLS. The
-- DO block keeps the setting and both updates in one statement, however the migration
-- runner batches statements.
DO $$
BEGIN
  PERFORM set_config('app.is_platform_admin', 'true', true);

  UPDATE "pharmacy_manufacturing_batches"
  SET "expiresAt" = pharmacy_local_expiry_boundary("expiresAt", "organizationId")
  WHERE "expiresAt" = date_trunc('day', "expiresAt");

  UPDATE "pharmacy_inventory_lots"
  SET "receivedExpiresAt" = pharmacy_local_expiry_boundary("receivedExpiresAt", "organizationId")
  WHERE "receivedExpiresAt" = date_trunc('day', "receivedExpiresAt");
END;
$$;
