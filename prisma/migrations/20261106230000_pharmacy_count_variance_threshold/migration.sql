BEGIN;

-- The stock-count variance threshold decides whether a count needs a second-person
-- (or SOLO owner PIN) approval. It used to come from the request body, so the
-- counter could pick a threshold large enough to skip approval. It is now an
-- owner-controlled tenant setting. The default 0 is the strictest value: every
-- non-zero variance needs approval until the owner chooses a tolerance. The upper
-- bound 10 is PHARMACY_COUNT_MAX_VARIANCE_THRESHOLD_UNITS: no owner setting can
-- loosen the policy ceiling.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS "pharmacyCountVarianceThresholdUnits" INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE organizations
    ADD CONSTRAINT organizations_pharmacy_count_variance_threshold_check
    CHECK ("pharmacyCountVarianceThresholdUnits" BETWEEN 0 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Unapproved counts written before this migration carry a caller-chosen threshold
-- (uncapped before 983f23b5, up to 10 after). Re-snapshot them to the organization
-- policy (0 for every tenant at this point) BEFORE the immutability trigger exists,
-- so no pre-deploy count can still be approved under the counter's choice.
-- Both tables force RLS, including for a NOSUPERUSER/NOBYPASSRLS owner; keep the
-- administrative scope local to this transaction.
SELECT set_config('app.is_platform_admin', 'true', true);
UPDATE pharmacy_inventory_counts c
   SET "varianceThreshold" = LEAST(c."varianceThreshold", o."pharmacyCountVarianceThresholdUnits")
  FROM organizations o
 WHERE o.id = c."organizationId"
   AND c.status <> 'APPROVED'
   AND c."varianceThreshold" > o."pharmacyCountVarianceThresholdUnits";

-- Defense in depth: a count always snapshots the tenant setting at creation, and the
-- snapshot never changes afterwards. A value supplied by any writer is ignored.
CREATE OR REPLACE FUNCTION pharmacy_count_variance_threshold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT o."pharmacyCountVarianceThresholdUnits" INTO NEW."varianceThreshold"
      FROM organizations o WHERE o.id = NEW."organizationId";
    IF NEW."varianceThreshold" IS NULL THEN
      RAISE EXCEPTION 'Count organization not found' USING ERRCODE = '23503';
    END IF;
  ELSIF NEW."varianceThreshold" IS DISTINCT FROM OLD."varianceThreshold" THEN
    RAISE EXCEPTION 'Count variance threshold is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- BEFORE triggers fire in name order: "pharmacy_count_a_..." runs before
-- pharmacy_count_solo, so the solo guard always sees the server-side snapshot.
DROP TRIGGER IF EXISTS pharmacy_count_a_threshold_snapshot ON pharmacy_inventory_counts;
CREATE TRIGGER pharmacy_count_a_threshold_snapshot
  BEFORE INSERT OR UPDATE OF "varianceThreshold" ON pharmacy_inventory_counts
  FOR EACH ROW EXECUTE FUNCTION pharmacy_count_variance_threshold_guard();

COMMIT;
