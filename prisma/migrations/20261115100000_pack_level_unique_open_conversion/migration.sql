BEGIN;

-- Close earlier duplicate open conversions (keep the referenced / oldest one)
-- so the unique index below can be built. Closing sets effectiveTo only,
-- which the referenced-pack immutability trigger permits.
UPDATE "pharmacy_pack_levels" p
SET "effectiveTo" = p."effectiveFrom"
FROM (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY "organizationId", "presentationId", COALESCE("parentPackLevelId", ''), "level", "unitsPerParent"
    ORDER BY ("referencedAt" IS NULL), "createdAt", id
  ) AS rn
  FROM "pharmacy_pack_levels" WHERE "effectiveTo" IS NULL
) d
WHERE p.id = d.id AND d.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "pharmacy_pack_levels_open_conversion_key"
ON "pharmacy_pack_levels" ("organizationId", "presentationId", COALESCE("parentPackLevelId", ''), "level", "unitsPerParent")
WHERE "effectiveTo" IS NULL;

COMMIT;
