-- WHA-908: stable, readable branch identifiers for tenant workflows.
CREATE SEQUENCE "restaurant_branch_code_seq" AS BIGINT;

ALTER TABLE "restaurant_branches" ADD COLUMN "code" VARCHAR(24);

-- Existing locations receive a deterministic, collision-free code within their
-- tenant. Creation order keeps the values compact and understandable to staff.
DO $$
DECLARE max_locations BIGINT;
BEGIN
  SELECT COALESCE(MAX(location_count), 0)
  INTO max_locations
  FROM (
    SELECT COUNT(*) AS location_count
    FROM "restaurant_branches"
    GROUP BY "organizationId"
  ) AS tenant_counts;

  IF LENGTH(max_locations::TEXT) > 21 THEN
    RAISE EXCEPTION 'Restaurant branch code allocation exceeds the 24-character contract';
  END IF;
END $$;

WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "organizationId"
           ORDER BY "createdAt", "id"
         ) AS branch_number
  FROM "restaurant_branches"
)
UPDATE "restaurant_branches" AS branch
SET "code" = 'BR-' || ranked.branch_number::TEXT
FROM ranked
WHERE ranked."id" = branch."id";

SELECT SETVAL(
  'restaurant_branch_code_seq',
  GREATEST(
    COALESCE((
      SELECT MAX(location_count)
      FROM (
        SELECT COUNT(*) AS location_count
        FROM "restaurant_branches"
        GROUP BY "organizationId"
      ) AS tenant_counts
    ), 0),
    1
  ),
  EXISTS (SELECT 1 FROM "restaurant_branches")
);

ALTER TABLE "restaurant_branches" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "restaurant_branches" ALTER COLUMN "code"
  SET DEFAULT ('BR-' || NEXTVAL('restaurant_branch_code_seq')::TEXT);

CREATE UNIQUE INDEX "restaurant_branches_organizationId_code_key"
  ON "restaurant_branches" ("organizationId", UPPER("code"));

-- Repair the legacy state before the new primary invariant is checked. Existing
-- duplicate names remain legal; WHA-908 only prevents new duplicates in its API.
UPDATE "restaurant_branches" SET "isDefault" = false WHERE NOT "active" AND "isDefault";

WITH missing_primary AS (
  SELECT DISTINCT ON ("organizationId") "id"
  FROM "restaurant_branches" AS branch
  WHERE branch."active"
    AND NOT EXISTS (
      SELECT 1 FROM "restaurant_branches" AS primary_branch
      WHERE primary_branch."organizationId" = branch."organizationId"
        AND primary_branch."active"
        AND primary_branch."isDefault"
    )
  ORDER BY "organizationId", "createdAt", "id"
)
UPDATE "restaurant_branches" AS branch
SET "isDefault" = true
FROM missing_primary
WHERE missing_primary."id" = branch."id";

ALTER TABLE "restaurant_branches"
  ADD CONSTRAINT "restaurant_branches_code_contract_check" CHECK (
    "code" = BTRIM("code")
    AND "code" = UPPER("code")
    AND CHAR_LENGTH("code") BETWEEN 2 AND 24
    AND "code" ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'
  ),
  ADD CONSTRAINT "restaurant_branches_default_active_check" CHECK (NOT "isDefault" OR "active");
