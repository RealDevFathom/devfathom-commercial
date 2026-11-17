BEGIN;

-- pharmacy_pack_levels has forced row-level security: without platform-admin
-- scope the duplicate check would see no rows and the index build could fail.
SELECT set_config('app.is_platform_admin', 'true', true);

-- Non-destructive duplicate-pack guard. Existing rows are never closed,
-- re-parented or deleted: that could change stock conversions or referenced
-- history. The unique index is built only when the open packs contain no
-- duplicates; otherwise it is skipped (the createPackLevel guard still
-- refuses new duplicates) and the duplicates are left for an owner decision.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pharmacy_pack_levels"
    WHERE "effectiveTo" IS NULL
    GROUP BY "organizationId", "presentationId", COALESCE("parentPackLevelId", ''), "level", "unitsPerParent"
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_pack_levels_open_conversion_key"
    ON "pharmacy_pack_levels" ("organizationId", "presentationId", COALESCE("parentPackLevelId", ''), "level", "unitsPerParent")
    WHERE "effectiveTo" IS NULL;
  ELSE
    RAISE NOTICE 'pharmacy_pack_levels has duplicate open packs; unique index skipped pending owner review';
  END IF;
END $$;

COMMIT;
