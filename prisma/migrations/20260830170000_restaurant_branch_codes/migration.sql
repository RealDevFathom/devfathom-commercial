-- WHA-908: stable, readable branch identifiers for tenant workflows.
ALTER TABLE "restaurant_branches" ADD COLUMN "code" VARCHAR(24);

-- Existing locations receive a deterministic, collision-free code within their
-- tenant. Creation order keeps the values compact and understandable to staff.
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "organizationId"
           ORDER BY "createdAt", "id"
         ) AS branch_number
  FROM "restaurant_branches"
)
UPDATE "restaurant_branches" AS branch
SET "code" = 'BR-' || LPAD(ranked.branch_number::TEXT, 4, '0')
FROM ranked
WHERE ranked."id" = branch."id";

ALTER TABLE "restaurant_branches" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "restaurant_branches" ALTER COLUMN "code"
  SET DEFAULT ('BR-' || UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 8)));

CREATE UNIQUE INDEX "restaurant_branches_organizationId_code_key"
  ON "restaurant_branches" ("organizationId", UPPER("code"));
CREATE UNIQUE INDEX "restaurant_branches_organizationId_name_ci_key"
  ON "restaurant_branches" ("organizationId", LOWER("name"));
