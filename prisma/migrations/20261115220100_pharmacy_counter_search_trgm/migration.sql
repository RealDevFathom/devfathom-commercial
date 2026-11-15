BEGIN;

-- DEV-575: counter search filters each catalogue column with ILIKE '%term%'.
-- The existing expression trigram indexes (product || brand, form || presentation)
-- cannot serve a filter on a single column, so every typed search scanned the
-- tenant's catalogue. One trigram index per searched column lets the planner use
-- a bitmap index scan for each OR branch.
--
-- pg_trgm is prepared by prisma/prepare-extensions.ts, not created here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION
      'pg_trgm is not installed. Run prisma/prepare-extensions.ts (EXTENSION_ADMIN_DATABASE_URL) before migrating; this migration does not create extensions.';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "pharmacy_medicines_productName_trgm_idx"
  ON "pharmacy_medicines" USING GIN ("productName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "pharmacy_medicines_brandName_trgm_idx"
  ON "pharmacy_medicines" USING GIN ("brandName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "pharmacy_medicines_manufacturer_trgm_idx"
  ON "pharmacy_medicines" USING GIN ("manufacturer" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "pharmacy_medicines_drapRegistrationNumber_trgm_idx"
  ON "pharmacy_medicines" USING GIN ("drapRegistrationNumber" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "pharmacy_presentations_presentation_trgm_idx"
  ON "pharmacy_presentations" USING GIN ("presentation" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "pharmacy_presentations_dosageForm_trgm_idx"
  ON "pharmacy_presentations" USING GIN ("dosageForm" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "pharmacy_presentations_route_trgm_idx"
  ON "pharmacy_presentations" USING GIN ("route" gin_trgm_ops);

COMMIT;
