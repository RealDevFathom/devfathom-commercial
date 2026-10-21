-- Narcotics register, spec §3 retention — a controlled-drug register entry cannot be
-- hard-deleted inside its retention window. The window is at least 3 years from the
-- later of the entry's own date and the last entry in that branch register (§7e), the
-- statutory floor from the Punjab, Balochistan and Sindh rules (and federal SRO
-- 1214(I)/96). The register is already append-only in the application; this makes the
-- "no edits/no deletes" guarantee enforceable at the row, where an inspector relies on it.
--
-- The one authorized exception is a whole-tenant purge, recognised exactly as the
-- regulatory-profile and onboarding-event guards do: "app.purging_organization_id"
-- names this row's tenant, or the organization no longer exists.

CREATE OR REPLACE FUNCTION pharmacy_controlled_register_retention_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE last_ts timestamp(3); retained_until timestamp(3);
BEGIN
  IF NULLIF(current_setting('app.purging_organization_id', true), '') = OLD."organizationId" THEN
    RETURN OLD;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "organizations" WHERE "id" = OLD."organizationId") THEN
    RETURN OLD;
  END IF;

  SELECT max("createdAt") INTO last_ts
    FROM "pharmacy_controlled_register_entries"
    WHERE "organizationId" = OLD."organizationId" AND "branchId" = OLD."branchId";
  retained_until := greatest(OLD."createdAt", COALESCE(last_ts, OLD."createdAt"))
    + interval '3 years';
  IF now() < retained_until THEN
    RAISE EXCEPTION 'controlled register entry is within its 3-year retention window (until %)', retained_until
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER pharmacy_controlled_register_retention
  BEFORE DELETE ON "pharmacy_controlled_register_entries"
  FOR EACH ROW EXECUTE FUNCTION pharmacy_controlled_register_retention_guard();
